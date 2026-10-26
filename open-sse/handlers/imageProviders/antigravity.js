// Antigravity image adapter - delegates to the executor for correct request
// envelope (project, model, requestType, sessionId) and auth headers.
import { nowSec, sizeToAspectRatio } from "./_base.js";
import { getExecutor } from "../../executors/index.js";
import { detectImageMime, fetchImageAsBase64, parseDataUri } from "../../translator/concerns/image.js";

// Antigravity accepts up to 10 reference images per request
const MAX_REFERENCE_IMAGES = 10;

// Convert image input (data URI, remote URL, or raw base64) to Gemini inlineData part
async function resolveImageInput(input) {
  if (input && typeof input === "object") {
    input = input.image_url?.url || input.url || input.data || input.b64_json;
  }
  if (!input || typeof input !== "string") return null;
  let parsed = parseDataUri(input);

  if (!parsed && /^https?:\/\//i.test(input)) {
    const fetched = await fetchImageAsBase64(input, { timeoutMs: 15000 });
    parsed = fetched ? parseDataUri(fetched.url) : null;
  }

  if (parsed?.mimeType?.startsWith("image/")) {
    const detectedMime = detectImageMime(Buffer.from(parsed.base64.slice(0, 32), "base64"));
    return { inlineData: { mimeType: detectedMime || parsed.mimeType, data: parsed.base64 } };
  }

  // Raw base64 string (assume PNG)
  if (/^[A-Za-z0-9+/]/.test(input) && input.length > 100 && !input.startsWith("http")) {
    return { inlineData: { mimeType: "image/png", data: input } };
  }
  return null;
}

function buildImagePrompt(prompt, referenceCount) {
  const referenceInstruction = referenceCount > 0
    ? `Use all ${referenceCount} attached reference image${referenceCount === 1 ? "" : "s"} in the result. `
    : "";
  return `Generate an image as the final response. ${referenceInstruction}Do not answer with text only.\n\n${prompt}`;
}

function parseQuotaResetAt(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    const details = data?.error?.details || [];
    for (const detail of details) {
      const timestamp = detail?.metadata?.quotaResetTimeStamp;
      const resetAtMs = timestamp ? Date.parse(timestamp) : NaN;
      if (Number.isFinite(resetAtMs) && resetAtMs > Date.now()) return resetAtMs;

      const retryDelay = detail?.retryDelay;
      const delayMatch = typeof retryDelay === "string" ? retryDelay.match(/^(\d+(?:\.\d+)?)s$/) : null;
      if (delayMatch) {
        const delayMs = Number(delayMatch[1]) * 1000;
        if (Number.isFinite(delayMs) && delayMs > 0) return Date.now() + delayMs;
      }
    }
  } catch {}
  return null;
}

// Collect reference images from the accepted request field shapes
function collectImageInputs(body) {
  const candidates = [
    body.reference_images,
    body.images,
    body.reference_image,
    body.image,
  ];
  return candidates
    .flatMap(v => (Array.isArray(v) ? v : v ? [v] : []))
    .slice(0, MAX_REFERENCE_IMAGES);
}

export default {
  // Delegate to executor instead of building URL/headers/body manually
  useExecutor: true,

  // Stubs - required by imageGenerationCore interface but unused with useExecutor
  buildUrl: () => "",
  buildHeaders: () => ({}),
  buildBody: () => ({}),

  async executeViaExecutor(model, body, credentials, log) {
    const executor = getExecutor("antigravity");
    if (!executor) throw new Error("Antigravity executor not found");

    // Ensure we use an image model for image generation.
    const isImageModel = (m) => /image|imagen|image-generation/i.test(m || "");
    let targetModel = isImageModel(model) ? model : "gemini-3.1-flash-image";

    // Aspect ratio: explicit body.aspect_ratio wins, then body.size
    let ratio = null;
    if (body.aspect_ratio && /^\d{1,2}:\d{1,2}$/.test(String(body.aspect_ratio))) {
      ratio = String(body.aspect_ratio);
    } else if (body.size && typeof body.size === "string") {
      ratio = sizeToAspectRatio(body.size);
    }
    if (ratio) {
      const suffix = ratio.replace(":", "x");
      if (!targetModel.includes(suffix)) {
        targetModel = `${targetModel}-${suffix}`;
      }
    }

    // Build parts: reference images first, then the text prompt
    const imageInputs = collectImageInputs(body);
    const parts = [];
    for (const imageInput of imageInputs) {
      const inlineData = await resolveImageInput(imageInput);
      if (!inlineData) {
        const error = new Error("Invalid reference image. Use a data URL, HTTP(S) URL, or raw base64 image.");
        error.status = 400;
        error.retryable = false;
        throw error;
      }
      parts.push(inlineData);
    }

    // Gemini image models have no negative prompt param — fold it into the prompt text
    const basePrompt = body.negative_prompt
      ? `${body.prompt}\n\nNegative prompt: ${body.negative_prompt}`
      : body.prompt;
    parts.push({ text: buildImagePrompt(basePrompt, parts.length) });

    const chatBody = {
      contents: [{ role: "user", parts }],
    };

    const result = await executor.execute({
      model: targetModel,
      body: chatBody,
      stream: false,
      credentials,
      log,
    });

    if (!result.response.ok) {
      const text = await result.response.text();
      const error = new Error(text || `HTTP ${result.response.status}`);
      error.status = result.response.status;
      error.resetsAtMs = parseQuotaResetAt(text);
      throw error;
    }

    return result.response.json();
  },

  normalize: (responseBody, prompt) => {
    const candidates = responseBody.candidates || responseBody.response?.candidates || [];
    const parts = candidates[0]?.content?.parts || [];
    const images = parts.map((p) => p.inlineData || p.inline_data)
      .filter((inlineData) => inlineData?.data)
      .map((inlineData) => ({ b64_json: inlineData.data }));
    if (images.length === 0) {
      const text = parts.map((p) => p.text).filter(Boolean).join(" ").trim();
      throw new Error(text
        ? `Antigravity returned text instead of an image: ${text}`
        : "Antigravity did not return an image.");
    }
    return { created: nowSec(), data: images };
  },
};
