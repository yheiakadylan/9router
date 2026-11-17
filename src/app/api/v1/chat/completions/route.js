import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { getImageStudioAssetDataUrl } from "@/lib/db";

let initialized = false;

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

export async function POST(request) {  
  // Fallback to local handling
  await ensureInitialized();

  if (request.headers.get("x-image-studio-conversation-id")) {
    try {
      const body = await request.clone().json();
      for (const message of body.messages || []) {
        if (!Array.isArray(message?.content)) continue;
        for (const part of message.content) {
          const value = part?.image_url?.url;
          const match = typeof value === "string" ? value.match(/^\/api\/image-studio\/assets\/([^/?#]+)/) : null;
          if (!match) continue;
          const dataUrl = await getImageStudioAssetDataUrl(decodeURIComponent(match[1]));
          if (dataUrl) part.image_url.url = dataUrl;
        }
      }
      request = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(body),
      });
    } catch {
      // The chat handler owns malformed JSON errors.
    }
  }

  return await handleChat(request);
}

