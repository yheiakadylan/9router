// Codex (ChatGPT Plus/Pro) image generation via Responses API + SSE
import { randomUUID } from "node:crypto";
import { nowSec } from "./_base.js";
import { PROVIDERS } from "../../config/providers.js";
import { CODEX_CLIENT_VERSION } from "../../config/codexConstants.js";
import { detectImageMime, encodeDataUri, fetchImageAsBase64, parseDataUri } from "../../translator/concerns/image.js";

const CODEX_RESPONSES_URL = PROVIDERS["codex"].baseUrl;
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_MODEL_SUFFIX = "-image";
const CODEX_REF_DETAIL = "high";
const CODEX_IMAGES_MAIN_MODEL = "gpt-5.5";
const CODEX_TOOL_IMAGE_MODELS = new Set([
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
]);

// These failures describe the request/model contract, not account health.
function isRequestScopedError(status, message) {
  if (Number(status) !== 400) return false;
  const text = String(message || "");
  return /requires a newer version of codex/i.test(text) ||
    /model[\s\S]{0,160}(?:not supported|unsupported|does not exist|not found|not available|do not have access|access denied)/i.test(text) ||
    /(?:not supported|unsupported|does not exist|not found|not available|do not have access|access denied)[\s\S]{0,160}model/i.test(text) ||
    /model[_\s-]*not[_\s-]*found/i.test(text);
}

function decodeAccountId(idToken) {
  try {
    const parts = String(idToken || "").split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (b64.length % 4)) % 4;
    const payload = JSON.parse(Buffer.from(b64 + "=".repeat(pad), "base64").toString("utf8"));
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id || null;
  } catch {
    return null;
  }
}

function stripImageSuffix(model) {
  return model.endsWith(CODEX_MODEL_SUFFIX) ? model.slice(0, -CODEX_MODEL_SUFFIX.length) : model;
}

function resolveCodexImageModels(model) {
  if (CODEX_TOOL_IMAGE_MODELS.has(model)) {
    return { responsesModel: CODEX_IMAGES_MAIN_MODEL, toolModel: model };
  }
  return { responsesModel: stripImageSuffix(model), toolModel: null };
}

function decodeBase64Image(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const headerBuffer = Buffer.from(trimmed.slice(0, 64), "base64");
    if (!headerBuffer.length) return null;
    const mimeType = detectImageMime(headerBuffer);
    return mimeType ? { base64: trimmed, mimeType } : null;
  } catch {
    return null;
  }
}

async function toDataUrl(input, label) {
  if (!input || typeof input !== "string") {
    throw new Error(`Invalid reference image at ${label}. Use an image URL, image data URL, or raw image base64.`);
  }

  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const fetched = await fetchImageAsBase64(trimmed);
    if (fetched) return fetched.url;
    throw new Error(`Unable to download reference image at ${label}. Check that the URL is public and still available.`);
  }

  const parsed = parseDataUri(trimmed);
  if (parsed?.mimeType?.startsWith("image/")) {
    const decoded = decodeBase64Image(parsed.base64);
    if (decoded) return encodeDataUri(decoded.mimeType, decoded.base64);
  }

  const decoded = decodeBase64Image(trimmed);
  if (decoded) return encodeDataUri(decoded.mimeType, decoded.base64);

  throw new Error(`Invalid reference image at ${label}. Use an image URL, image data URL, or raw image base64.`);
}

function buildContent(prompt, refs, detail = CODEX_REF_DETAIL) {
  const content = [];
  refs.forEach((url, index) => {
    content.push({ type: "input_text", text: `<image name=image${index + 1}>` });
    content.push({ type: "input_image", image_url: url, detail });
    content.push({ type: "input_text", text: "</image>" });
  });
  content.push({ type: "input_text", text: prompt });
  return content;
}

function extractStreamError(data) {
  if (!data) return null;
  if (typeof data === "string") return data;
  if (data.error?.message) return data.error.message;
  if (data.response?.error?.message) return data.response.error.message;
  if (data.item?.error?.message) return data.item.error.message;
  if (data.response?.status_details?.error?.message) return data.response.status_details.error.message;
  if (typeof data.error === "string") return data.error;
  if (typeof data.message === "string") return data.message;
  if (data.error?.code) return `OpenAI error: ${data.error.code}`;
  if (data.response?.error?.code) return `OpenAI error: ${data.response.error.code}`;
  return null;
}

// Parse Codex SSE stream → final base64 image or upstream error. Optional callbacks for client streaming.
async function parseStream(response, log, callbacks = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let imageB64 = null;
  let upstreamError = null;
  let assistantText = "";
  let lastEvent = null;
  let bytesReceived = 0;
  let lastProgressLogMs = 0;
  let firstChunkAt = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!firstChunkAt) {
      firstChunkAt = Date.now();
      callbacks.onFirstChunk?.(firstChunkAt);
    }
    bytesReceived += value?.byteLength || 0;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);

      const lines = block.split("\n");
      let eventName = null;
      let dataStr = "";
      for (const line of lines) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (!eventName) continue;
      if (eventName !== lastEvent) {
        log?.info?.("IMAGE", `codex progress: ${eventName}`);
        lastEvent = eventName;
      }

      const now = Date.now();
      if (callbacks.onProgress && now - lastProgressLogMs > 200) {
        lastProgressLogMs = now;
        callbacks.onProgress({ stage: eventName, bytesReceived });
      }

      if (eventName === "response.image_generation_call.partial_image" && dataStr) {
        try {
          const data = JSON.parse(dataStr);
          if (callbacks.onPartialImage && data?.partial_image_b64) {
            callbacks.onPartialImage({ b64_json: data.partial_image_b64, index: data.partial_image_index });
          }
        } catch {}
      }

      if ((eventName === "error" || eventName === "response.failed") && dataStr) {
        try {
          const data = JSON.parse(dataStr);
          const err = extractStreamError(data);
          if (err) {
            upstreamError = err;
            log?.warn?.("IMAGE", `codex stream error: ${err}`);
          }
        } catch {
          if (dataStr) upstreamError = dataStr;
        }
      }

      if (eventName === "response.output_text.delta" && dataStr) {
        try {
          const data = JSON.parse(dataStr);
          if (data?.delta) {
            assistantText += data.delta;
          }
        } catch {}
      }

      if (eventName === "response.output_item.done" && dataStr) {
        try {
          const data = JSON.parse(dataStr);
          const item = data?.item;
          if (item?.type === "image_generation_call") {
            if (item.result) {
              imageB64 = item.result;
            } else if (item.error || item.status === "failed") {
              const err = extractStreamError(item);
              if (err) {
                upstreamError = err;
                log?.warn?.("IMAGE", `codex image tool error: ${err}`);
              }
            }
          } else if (item?.type === "message") {
            const textParts = item.content
              ?.map((c) => (typeof c === "string" ? c : c?.text || c?.output_text))
              .filter(Boolean);
            if (textParts && textParts.length > 0) {
              assistantText = textParts.join(" ").trim();
            }
          }
        } catch {}
      }
    }
  }

  let finalError = upstreamError;
  if (!imageB64 && !finalError && assistantText) {
    finalError = `Codex returned text instead of an image: "${assistantText.trim().slice(0, 300)}"`;
  }

  return { b64: imageB64, error: finalError };
}

// SSE Response that pipes codex progress + partial + done events to client
function buildSseResponse(providerResponse, log, onSuccess, onComplete) {
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let firstChunkAt = null;
      const send = (event, data) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const notifyComplete = (result) => {
        try {
          Promise.resolve(onComplete?.(result)).catch(() => {});
        } catch {}
      };
      try {
        const { b64, error: upstreamError } = await parseStream(providerResponse, log, {
          onFirstChunk: (timestamp) => { firstChunkAt = timestamp; },
          onProgress: (info) => send("progress", info),
          onPartialImage: (info) => send("partial_image", info),
        });
        const completedAt = Date.now();
        if (!b64) {
          const message = upstreamError || "Codex did not return an image. Account may not be entitled (Plus/Pro required) or request was rejected.";
          send("error", { message });
          notifyComplete({ success: false, error: message, firstChunkAt, completedAt });
        } else {
          if (onSuccess) await onSuccess();
          const response = { created: nowSec(), data: [{ b64_json: b64 }] };
          send("done", response);
          notifyComplete({ success: true, response, firstChunkAt, completedAt });
        }
      } catch (err) {
        const message = err?.message || "Stream failed";
        send("error", { message });
        notifyComplete({ success: false, error: message, firstChunkAt, completedAt: Date.now() });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export default {
  stream: true,
  isRequestScopedError,
  buildUrl: () => CODEX_RESPONSES_URL,
  buildHeaders: (creds) => {
    const accountId = creds?.providerSpecificData?.chatgptAccountId || decodeAccountId(creds?.idToken);
    return {
      "accept": "text/event-stream, application/json",
      "authorization": `Bearer ${creds?.accessToken || ""}`,
      "chatgpt-account-id": accountId || "",
      "content-type": "application/json",
      "originator": CODEX_ORIGINATOR,
      "session_id": randomUUID(),
      "user-agent": `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION}`,
      "version": CODEX_CLIENT_VERSION,
      "x-client-request-id": randomUUID(),
    };
  },
  buildBody: async (model, body) => {
    const refs = [];
    if (Array.isArray(body.images)) {
      for (const [index, image] of body.images.entries()) {
        refs.push(await toDataUrl(image, `images[${index}]`));
      }
    }
    if (body.image != null && body.image !== "") {
      refs.push(await toDataUrl(body.image, "image"));
    }
    const detail = body.image_detail || CODEX_REF_DETAIL;
    const { responsesModel, toolModel } = resolveCodexImageModels(model);
    const imgTool = { type: "image_generation", output_format: (body.output_format || "png").toLowerCase() };
    if (toolModel) {
      imgTool.action = refs.length > 0 ? "edit" : "generate";
      imgTool.model = toolModel;
    }
    if (body.size && body.size !== "") imgTool.size = body.size;
    if (body.quality && body.quality !== "") imgTool.quality = body.quality;
    if (body.background && body.background !== "") imgTool.background = body.background;
    if (body.moderation) imgTool.moderation = body.moderation;
    if (Number.isFinite(Number(body.output_compression))) imgTool.output_compression = Number(body.output_compression);
    if (Number.isFinite(Number(body.partial_images))) imgTool.partial_images = Number(body.partial_images);
    return {
      model: responsesModel,
      instructions: "",
      input: [{ type: "message", role: "user", content: buildContent(body.prompt, refs, detail) }],
      tools: [imgTool],
      // /images/generations must produce an image even when the prompt could be answered as text.
      tool_choice: toolModel ? { type: "image_generation" } : "required",
      parallel_tool_calls: false,
      prompt_cache_key: randomUUID(),
      stream: true,
      store: false,
      reasoning: toolModel ? { effort: "medium", summary: "auto" } : null,
    };
  },
  // Custom: codex parses SSE → either pipe to client or collect b64
  async parseResponse(response, { log, streamToClient, onRequestSuccess, onStreamComplete }) {
    if (streamToClient) {
      return { sseResponse: buildSseResponse(response, log, onRequestSuccess, onStreamComplete) };
    }
    const { b64, error: upstreamError } = await parseStream(response, log);
    if (!b64) {
      throw new Error(upstreamError || "Codex did not return an image. Account may not be entitled (Plus/Pro required) or request was rejected.");
    }
    return { created: nowSec(), data: [{ b64_json: b64 }] };
  },
  normalize: (responseBody) => responseBody,
};
