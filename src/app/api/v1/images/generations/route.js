import { handleImageGeneration } from "@/sse/handlers/imageGeneration.js";
import { getImageStudioAssetDataUrl, saveImageStudioAsset } from "@/lib/db";

async function resolveStudioReference(value) {
  if (typeof value !== "string") return value;
  const match = value.match(/^\/api\/image-studio\/assets\/([^/?#]+)/);
  if (!match) return value;
  return await getImageStudioAssetDataUrl(decodeURIComponent(match[1])) || value;
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** POST /v1/images/generations - OpenAI-compatible image generation endpoint */
export async function POST(request) {
  const conversationId = request.headers.get("x-image-studio-conversation-id");
  let effectiveRequest = request;
  if (conversationId) {
    try {
      const body = await request.clone().json();
      if (body.image) body.image = await resolveStudioReference(body.image);
      if (Array.isArray(body.images)) body.images = await Promise.all(body.images.map(resolveStudioReference));
      effectiveRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(body),
      });
    } catch {
      // Let the normal image handler report malformed input.
    }
  }

  const response = await handleImageGeneration(effectiveRequest);
  if (!conversationId || !response.ok || !(response.headers.get("content-type") || "").includes("application/json")) {
    return response;
  }

  try {
    const payload = await response.clone().json();
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const nextData = [];
    for (const item of data) {
      if (!item?.b64_json) {
        nextData.push(item);
        continue;
      }
      const mimeType = item.b64_json.startsWith("/9j/") ? "image/jpeg" : "image/png";
      const asset = await saveImageStudioAsset({
        conversationId,
        mimeType,
        bytes: Buffer.from(item.b64_json, "base64"),
      });
      nextData.push({ ...item, url: asset.url, b64_json: undefined });
    }
    return Response.json({ ...payload, data: nextData }, {
      status: response.status,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.error("[IMAGE_STUDIO] output persistence failed:", error);
    return response;
  }
}
