// Google Gemini adapter (Nano Banana models)
import { nowSec } from "./_base.js";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export default {
  buildUrl: (model, creds) => {
    const apiKey = creds?.apiKey || creds?.accessToken;
    const modelId = model.replace(/^models\//, "");
    return `${BASE_URL}/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;
  },
  buildHeaders: () => ({ "Content-Type": "application/json" }),
  buildBody: (_model, body) => {
    const parts = [];
    if (body.prompt) parts.push({ text: body.prompt });
    
    if (body.image && body.image.startsWith("data:")) {
      const match = body.image.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2]
          }
        });
      }
    }
    
    // Nếu cả prompt và image đều không có, thêm text rỗng để tránh lỗi
    if (parts.length === 0) parts.push({ text: "" });

    return {
      contents: [{ parts }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    };
  },
  normalize: (responseBody, prompt) => {
    console.log("GEMINI RAW RESPONSE:", JSON.stringify(responseBody, null, 2));
    const parts = responseBody.candidates?.[0]?.content?.parts || [];
    const images = parts.filter((p) => p.inlineData?.data).map((p) => ({ b64_json: p.inlineData.data }));
    
    // Nếu không có ảnh, lấy phần text (nếu có) để xem Gemini nói gì
    let textResponse = parts.find((p) => p.text)?.text || prompt;
    
    return {
      created: nowSec(),
      data: images.length > 0 ? images : [{ b64_json: "", revised_prompt: textResponse }],
    };
  },
};
