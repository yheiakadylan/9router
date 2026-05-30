// Google Gemini adapter (Nano Banana models)
import { nowSec, urlToBase64 } from "./_base.js";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export default {
  buildUrl: (model, creds) => {
    const apiKey = creds?.apiKey || creds?.accessToken;
    const modelId = model.replace(/^models\//, "");
    return `${BASE_URL}/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;
  },
  buildHeaders: () => ({ "Content-Type": "application/json" }),
  buildBody: async (_model, body) => {
    const parts = [];
    if (body.prompt) parts.push({ text: body.prompt });
    
    if (body.image) {
      let b64Data = "";
      let mimeType = "image/jpeg";
      
      if (body.image.startsWith("data:")) {
        const match = body.image.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          b64Data = match[2];
        }
      } else if (body.image.startsWith("http")) {
        try {
          b64Data = await urlToBase64(body.image);
          if (body.image.toLowerCase().includes(".png")) mimeType = "image/png";
          else if (body.image.toLowerCase().includes(".webp")) mimeType = "image/webp";
        } catch (e) {
          console.error("Failed to fetch image URL for Gemini:", e);
        }
      }
      
      if (b64Data) {
        parts.push({
          inlineData: {
            mimeType,
            data: b64Data
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
