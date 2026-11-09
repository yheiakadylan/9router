// Codex OAuth image generation: native Images API for GPT Image, Responses SSE for edits.
import { randomUUID } from "node:crypto";
import { nowSec, uploadBase64ImageOutput, validateImageOutputUpload } from "./_base.js";
import { PROVIDERS } from "../../config/providers.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";
import { CODEX_CLI_VERSION } from "../../config/appConstants.js";
import { detectImageMime, encodeDataUri, fetchImageAsBase64, parseDataUri } from "../../translator/concerns/image.js";

const CODEX_RESPONSES_URL = PROVIDERS["codex"].baseUrl;
// Codex OAuth image generation uses the native Images endpoint. The Responses
// image_generation path has returned unsupported `complexity=medium` errors for
// GPT Image models. Native has ignored explicit n/size/format controls,
// so preserve Responses for those requests, edits, and older virtual models.
const CODEX_IMAGES_GENERATIONS_URL = PROVIDER_MEDIA.codex.imageConfig.baseUrl;
const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_CLI_VERSION}`;
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_MODEL_SUFFIX = "-image";
const CODEX_REF_DETAIL = "high";
// Only drives the image_generation tool call; any chat model on the plan works as host.
const CODEX_IMAGES_MAIN_MODEL = "gpt-6-sol";
const CODEX_TOOL_IMAGE_MODELS = new Set([
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
]);
const CODEX_IMAGE_25_VARIANTS = new Set([
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

function decodeOpenAIAuthClaims(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (b64.length % 4)) % 4;
    const payload = JSON.parse(Buffer.from(b64 + "=".repeat(pad), "base64").toString("utf8"));
    return payload?.["https://api.openai.com/auth"] || null;
  } catch {
    return null;
  }
}

function decodeAccountId(idToken) {
  return decodeOpenAIAuthClaims(idToken)?.chatgpt_account_id || null;
}

// Token claims first: the stored chatgptPlanType is only set at OAuth/import time and goes stale on plan changes.
function resolveChatgptPlanType(creds) {
  return decodeOpenAIAuthClaims(creds?.accessToken)?.chatgpt_plan_type
    || decodeOpenAIAuthClaims(creds?.idToken)?.chatgpt_plan_type
    || creds?.providerSpecificData?.chatgptPlanType
    || null;
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

function hasImageRefs(body) {
  return Boolean(body?.image || (Array.isArray(body?.images) && body.images.length > 0));
}

function shouldUseNativeGeneration(model, body = {}) {
  // Native Codex has been observed returning one auto-sized PNG even when n,
  // size, or output_format requests something else. Do not silently reroute
  // those requests to a transport that cannot honor their output controls.
  return CODEX_TOOL_IMAGE_MODELS.has(model)
    && !hasImageRefs(body)
    && !body?.output_upload
    && (body.n == null || body.n === 1)
    && (!body.size || body.size === "auto")
    && (!body.output_format || body.output_format.toLowerCase() === "png")
    && (!body.background || ["auto", "opaque"].includes(body.background))
    && (!body.quality || ["auto", "low", "medium", "high"].includes(body.quality))
    && body.output_compression == null;
}

function buildNativeGenerationBody(model, body) {
  return {
    model,
    prompt: body.prompt,
    n: 1,
    size: "auto",
    quality: body.quality || "auto",
    background: body.background || "auto",
    output_format: "png",
  };
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
    return decoded ? encodeDataUri(decoded.mimeType, decoded.base64) : trimmed;
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

function outputUrlForLog(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value || "");
  }
}

async function buildImageOutput(b64, outputUpload, log) {
  if (outputUpload) {
    try {
      const uploadedUrl = await uploadBase64ImageOutput(b64, outputUpload);
      log?.info?.("IMAGE", `codex output: url ${outputUrlForLog(uploadedUrl)}`);
      return { url: uploadedUrl };
    } catch (error) {
      const message = error?.message || String(error);
      if (message.startsWith("Generated image size is invalid:")) throw error;
      log?.warn?.("IMAGE", `direct image upload failed, falling back to base64: ${message}`);
    }
  }

  log?.info?.("IMAGE", `codex output: base64 (${b64.length} chars)`);
  return { b64_json: b64 };
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

function normalizeResponsesUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw.input_tokens ?? raw.prompt_tokens;
  const output = raw.output_tokens ?? raw.completion_tokens;
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) return null;

  const usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  const cached = raw.input_tokens_details?.cached_tokens
    ?? raw.prompt_tokens_details?.cached_tokens
    ?? raw.input_token_details?.cached_tokens
    ?? raw.prompt_tokens_details?.cached_tokens;
  if (Number.isSafeInteger(cached) && cached >= 0) usage.cached_tokens = cached;
  return usage;
}

function nativeImageSseResponse(result) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify(result)}\n\n`));
      controller.close();
    },
  }), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Parse Codex SSE stream → final base64 image or upstream error. Optional callbacks for client streaming.
async function parseStream(response, log, { onFirstChunk, onProgress, onPartialImage } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let imageB64 = null;
  let assistantText = "";
  let upstreamError = null;
  let upstreamErrorCode = null;
  let upstreamErrorType = null;
  let upstreamErrorParam = null;
  let firstChunkAt = null;
  let usage = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!firstChunkAt) {
        firstChunkAt = Date.now();
        onFirstChunk?.(firstChunkAt);
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep last incomplete line

      let eventName = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventName = line.slice(7).trim();
          continue;
        }
        if (!line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();

        if ((eventName === "error" || eventName === "response.failed") && dataStr) {
          let data;
          try { data = JSON.parse(dataStr); } catch {}
          const error = data?.error || data?.response?.error || data;
          const err = new Error(error?.message || `Codex upstream failed (${eventName})`);
          for (const key of ["code", "type", "param"]) {
            if (typeof error?.[key] === "string") err[key] = error[key];
          }
          throw err;
        }

        if (eventName === "response.image_generation_call.progress" && dataStr && onProgress) {
          try {
            const data = JSON.parse(dataStr);
            onProgress({ progress: data.progress ?? data.percentage ?? 0 });
          } catch {}
        }

        if (eventName === "response.image_generation_call.partial_image" && dataStr && onPartialImage) {
          try {
            const data = JSON.parse(dataStr);
            const partialB64 = data.partial_image_b64 || data.b64_json || data.image_b64;
            if (partialB64) {
              onPartialImage({ b64_json: partialB64, index: data.partial_image_index ?? 0 });
            }
          } catch {}
        }

        if (eventName === "response.output_item.done" && dataStr) {
          try {
            const data = JSON.parse(dataStr);
            const item = data.item;
            if (item?.type === "image_generation_call") {
              if (typeof item.result === "string" && item.result) {
                imageB64 = item.result;
              } else {
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

        if ((eventName === "response.completed" || eventName === "response.done") && dataStr) {
          try {
            const data = JSON.parse(dataStr);
            usage = normalizeResponsesUsage(data?.response?.usage ?? data?.usage) || usage;
            if (!imageB64) {
              const outputItems = Array.isArray(data?.response?.output) ? data.response.output : [];
              const imageCall = outputItems.find((item) => item?.type === "image_generation_call" && typeof item?.result === "string" && item.result);
              if (imageCall) imageB64 = imageCall.result;
            }
          } catch {}
        }
      }
    }
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }
  let finalError = upstreamError;
  if (!imageB64 && !finalError && assistantText) {
    finalError = `Codex returned text instead of an image: "${assistantText.trim().slice(0, 300)}"`;
  }

  return {
    imageB64,
    b64: imageB64,
    error: finalError,
    errorCode: upstreamErrorCode,
    errorType: upstreamErrorType,
    errorParam: upstreamErrorParam,
    usage,
  };
}

// SSE Response that pipes codex progress + partial + done events to client
function buildSseResponse(providerResponse, log, onSuccess, onComplete, onUsage, outputUpload) {
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
        const {
          imageB64: b64,
          error: upstreamError,
          errorCode,
          errorType,
          errorParam,
          usage,
        } = await parseStream(providerResponse, log, {
          onFirstChunk: (timestamp) => { firstChunkAt = timestamp; },
          onProgress: (info) => send("progress", info),
          onPartialImage: outputUpload ? undefined : (info) => send("partial_image", info),
        });
        const completedAt = Date.now();
        if (!b64) {
          const message = upstreamError || "Codex did not return an image. Account may not be entitled (paid ChatGPT plan required) or request was rejected.";
          send("error", {
            message,
            ...(errorCode ? { code: errorCode } : {}),
            ...(errorType ? { type: errorType } : {}),
            ...(errorParam ? { param: errorParam } : {}),
          });
          notifyComplete({ success: false, error: message, firstChunkAt, completedAt });
        } else {
          if (usage && onUsage) await onUsage(usage);
          const output = await buildImageOutput(b64, outputUpload, log);
          if (onSuccess) await onSuccess();
          const response = { created: nowSec(), data: [output] };
          send("done", response);
          notifyComplete({ success: true, response, firstChunkAt, completedAt });
        }
      } catch (err) {
        const message = err?.message || "Stream failed";
        send("error", {
          message,
          ...(err?.code ? { code: err.code } : {}),
          ...(err?.type ? { type: err.type } : {}),
          ...(err?.param ? { param: err.param } : {}),
        });
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
  // ChatGPT Free accounts have the image_generation tool stripped server-side
  // (upstream returns 400 "Tool choice 'image_generation' must be specified with 'tools' parameter").
  // Unknown plan is allowed so accounts without plan claims keep working.
  canUseCredentials: (creds) => resolveChatgptPlanType(creds) !== "free",
  buildUrl: (model, creds, body) => shouldUseNativeGeneration(model, body)
    ? CODEX_IMAGES_GENERATIONS_URL
    : CODEX_RESPONSES_URL,
  buildHeaders: (creds, requestBody) => {
    const accountId = creds?.providerSpecificData?.chatgptAccountId || decodeAccountId(creds?.idToken);
    return {
      "accept": requestBody?.prompt && !requestBody?.input
        ? "application/json"
        : "text/event-stream, application/json",
      "authorization": `Bearer ${creds?.accessToken || ""}`,
      "chatgpt-account-id": accountId || "",
      "content-type": "application/json",
      "originator": CODEX_ORIGINATOR,
      "session_id": randomUUID(),
      "user-agent": CODEX_USER_AGENT,
      "version": CODEX_CLI_VERSION,
      "x-client-request-id": randomUUID(),
    };
  },
  buildBody: async (model, body) => {
    validateImageOutputUpload(body?.output_upload);
    if (shouldUseNativeGeneration(model, body)) return buildNativeGenerationBody(model, body);

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
    if (CODEX_IMAGE_25_VARIANTS.has(toolModel) && (!body.quality || body.quality === "auto")) {
      // Legacy 2.5 variants reject their unresolved default upstream.
      imgTool.quality = "high";
    } else if (body.quality && body.quality !== "") {
      imgTool.quality = body.quality;
    }
    // The ChatGPT Codex backend currently rejects every explicit complexity level.
    // Omit it so GPT Image 2.6 uses its supported upstream default.
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
      reasoning: null,
    };
  },
  // Custom: codex parses SSE → either pipe to client or collect b64
  async parseResponse(response, { log, streamToClient, onRequestSuccess, onStreamComplete, onUsage, body, requestBody }) {
    if (requestBody?.prompt && !requestBody?.input) {
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Codex Images API returned invalid JSON.");
      }
      const data = Array.isArray(payload?.data) ? payload.data : [];
      if (!data.some((item) => item?.b64_json || item?.url)) {
        const error = payload?.error || {};
        const err = new Error(error.message || "Codex Images API returned no image.");
        for (const key of ["code", "type", "param"]) {
          if (typeof error[key] === "string") err[key] = error[key];
        }
        throw err;
      }
      if (body?.output_upload && data[0]?.b64_json) {
        const output = await buildImageOutput(data[0].b64_json, body.output_upload, log);
        data[0] = output;
      }
      const result = { created: payload.created || nowSec(), data };
      const usage = normalizeResponsesUsage(payload.usage);
      if (streamToClient) {
        if (usage && onUsage) await onUsage(usage);
        if (onRequestSuccess) await onRequestSuccess();
        if (onStreamComplete) {
          try {
            onStreamComplete({ success: true, response: result, firstChunkAt: Date.now(), completedAt: Date.now() });
          } catch {}
        }
        return { sseResponse: nativeImageSseResponse(result) };
      }
      if (usage && onUsage) await onUsage(usage);
      return result;
    }

    if (streamToClient) {
      return { sseResponse: buildSseResponse(response, log, onRequestSuccess, onStreamComplete, onUsage, body?.output_upload) };
    }
    const { imageB64: b64, usage, error: upstreamError } = await parseStream(response, log);
    if (!b64) {
      throw new Error(upstreamError || "Codex did not return an image. Account may not be entitled (paid ChatGPT plan required) or request was rejected.");
    }
    if (usage && onUsage) await onUsage(usage);
    const output = await buildImageOutput(b64, body?.output_upload, log);
    return { created: nowSec(), data: [output] };
  },
  normalize: (responseBody) => responseBody,
};
