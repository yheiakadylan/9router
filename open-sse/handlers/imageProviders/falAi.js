// Fal.ai — async submit + queue polling
import { sleep, nowSec, sizeToAspectRatio, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "./_base.js";

import { parseBase64DataUrl, getExtensionFromMime } from "../../utils/storage.js";

const BASE_URL = "https://queue.fal.run";

export default {
  async: true,
  buildUrl: (model) => `${BASE_URL}/${model}`,
  buildHeaders: (creds) => {
    const key = creds?.apiKey || creds?.accessToken;
    return { "Content-Type": "application/json", "Authorization": `Key ${key}` };
  },
  buildBody: async (_model, body, creds) => {
    const req = { prompt: body.prompt || "", num_images: body.n || 1 };
    if (body.size) req.image_size = sizeToAspectRatio(body.size);
    if (body.image) {
      if (body.image.startsWith("data:")) {
        const { buffer, mimeType } = parseBase64DataUrl(body.image);
        const ext = getExtensionFromMime(mimeType);
        
        // Upload to Fal Storage
        const key = creds?.apiKey || creds?.accessToken;
        const formData = new FormData();
        const blob = new Blob([buffer], { type: mimeType });
        formData.append("file", blob, `image.${ext}`);
        
        const uploadRes = await fetch("https://rest.fal.ai/storage/upload/", {
          method: "POST",
          headers: { "Authorization": `Key ${key}` },
          body: formData
        });
        
        if (!uploadRes.ok) throw new Error("Failed to upload image to Fal storage");
        const uploadData = await uploadRes.json();
        req.image_url = uploadData.url;
      } else {
        req.image_url = body.image;
      }
    }
    return req;
  },
  async parseResponse(response, { headers }) {
    const { status_url, response_url } = await response.json();
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const r = await fetch(status_url, { headers });
      if (!r.ok) throw new Error(`Fal status ${r.status}`);
      const s = await r.json();
      if (s.status === "COMPLETED") {
        const fr = await fetch(response_url, { headers });
        return await fr.json();
      }
      if (s.status === "FAILED") throw new Error(s.error || "Fal generation failed");
    }
    throw new Error("Fal polling timeout");
  },
  normalize: (responseBody) => {
    const images = Array.isArray(responseBody.images)
      ? responseBody.images
      : (responseBody.image ? [responseBody.image] : []);
    return { created: nowSec(), data: images.map((img) => ({ url: img.url || img })) };
  },
};
