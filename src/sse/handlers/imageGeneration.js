import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getDisabledByProvider } from "@/lib/disabledModelsDb";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { getModelInfo, getComboModels } from "../services/model.js";
import CODEX_REGISTRY from "open-sse/providers/registry/codex.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";
import { randomUUID } from "node:crypto";
import { trackPendingRequest } from "@/lib/usageDb.js";

// Providers that don't require credentials (noAuth)
const NO_AUTH_PROVIDERS = new Set(["sdwebui", "comfyui"]);
const CODEX_IMAGE_MODEL_IDS = CODEX_REGISTRY.models
  .filter((entry) => entry.kind === "image")
  .map((entry) => entry.id);
const CODEX_IMAGE_FALLBACKS = [
  "gpt-5.5-image",
  ...CODEX_IMAGE_MODEL_IDS.filter((id) => id !== "gpt-5.5-image"),
];

async function resolveCodexImageModel(model) {
  if (!CODEX_IMAGE_MODEL_IDS.includes(model)) return model;

  const disabled = new Set();
  for (const alias of ["cx", "codex"]) {
    const ids = (await getDisabledByProvider(alias).catch(() => [])) || [];
    for (const id of ids) disabled.add(id);
  }
  if (!disabled.has(model)) return model;

  return CODEX_IMAGE_FALLBACKS.find((id) => !disabled.has(id)) || null;
}

function withConnectionMetadata(response, credentials) {
  if (!response || !credentials?.connectionId) return response;

  const headers = new Headers(response.headers);
  headers.set("x-connection-id", credentials.connectionId);

  const exposed = new Set(
    (headers.get("Access-Control-Expose-Headers") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  exposed.add("x-connection-id");
  headers.set("Access-Control-Expose-Headers", [...exposed].join(", "));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Handle image generation request
 * @param {Request} request
 */
export async function handleImageGeneration(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const wantsStream = (request.headers.get("accept") || "").includes("text/event-stream");
  const binaryOutput = url.searchParams.get("response_format") === "binary";
  const modelStr = body.model;

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("IMAGE", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelImage(b, m, { wantsStream, binaryOutput, preferredConnectionId, apiKey }),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId, apiKey });
}

import { saveRequestDetail } from "@/lib/requestDetailsDb";

function estimateImageTokens(body) {
  const promptText = body?.prompt || "";
  // ~1 token per 4 chars for text prompt (min 10 tokens)
  const promptTextTokens = Math.max(10, Math.ceil(promptText.length / 4));
  // ~1000 tokens per reference input image
  const inputImagesCount = Array.isArray(body?.images) ? body.images.length : 0;
  const inputImageTokens = inputImagesCount * 1000;
  const prompt_tokens = promptTextTokens + inputImageTokens;

  // Estimated output image completion tokens (~1024 tokens)
  const completion_tokens = 1024;
  const total_tokens = prompt_tokens + completion_tokens;

  return { prompt_tokens, completion_tokens, total_tokens };
}

function sanitizeImagePayload(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeImagePayload(item));
  }
  const clean = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "string") {
      if (val.startsWith("data:image/") || (key === "b64_json" && val.length > 200)) {
        clean[key] = `[Base64 Image Data: ${val.length} chars]`;
      } else if (val.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(val.slice(0, 100))) {
        clean[key] = `[Base64 Data: ${val.length} chars]`;
      } else {
        clean[key] = val;
      }
    } else if (typeof val === "object" && val !== null) {
      clean[key] = sanitizeImagePayload(val);
    } else {
      clean[key] = val;
    }
  }
  return clean;
}

async function handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId, apiKey } = {}) {
  const startTime = Date.now();
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider } = modelInfo;
  let { model } = modelInfo;
  if (provider === "codex") {
    const routedModel = await resolveCodexImageModel(model);
    if (!routedModel) {
      return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "No active Codex image model available");
    }
    if (routedModel !== model) {
      log.info("IMAGE", `Codex model ${model} is disabled; falling back to ${routedModel}`);
      model = routedModel;
    }
  }
  const estimatedTokens = estimateImageTokens(body);
  const requestId = randomUUID();
  let streamPending = false;
  let streamReleased = false;
  const releaseImageRequest = () => {
    if (streamReleased) return;
    streamReleased = true;
    trackPendingRequest(model, provider, preferredConnectionId, false, false, "image", requestId);
  };
  trackPendingRequest(model, provider, preferredConnectionId, true, false, "image", requestId);

  try {

  // noAuth providers — no credential needed
  if (NO_AUTH_PROVIDERS.has(provider)) {
    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: null,
      binaryOutput,
    });
    const durationMs = Date.now() - startTime;
    if (result.success) {
      saveRequestUsage({
        provider,
        model,
        connectionId: null,
        apiKey: apiKey || null,
        endpoint: "/v1/images/generations",
        tokens: estimatedTokens,
        status: "success",
        durationMs,
      }).catch(() => {});
      saveRequestDetail({
        provider,
        model,
        connectionId: null,
        status: "success",
        endpoint: "/v1/images/generations",
        latency: { ttft: durationMs, total: durationMs },
        request: sanitizeImagePayload(body),
        response: sanitizeImagePayload(result.response),
      }).catch(() => {});
      return result.response;
    }
    saveRequestDetail({
      provider,
      model,
      connectionId: null,
      status: "error",
      endpoint: "/v1/images/generations",
      latency: { ttft: durationMs, total: durationMs },
      request: sanitizeImagePayload(body),
      response: { error: result.error },
    }).catch(() => {});
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Image generation failed");
  }

  // Credentialed providers — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId });

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      streamToClient: wantsStream,
      binaryOutput,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      },
      onStreamComplete: ({ success, response, error, firstChunkAt, completedAt }) => {
        releaseImageRequest();
        const finishedAt = completedAt || Date.now();
        const durationMs = finishedAt - startTime;
        const ttftMs = firstChunkAt ? firstChunkAt - startTime : durationMs;

        if (success) {
          saveRequestUsage({
            provider,
            model,
            connectionId: credentials.connectionId,
            apiKey: apiKey || null,
            endpoint: "/v1/images/generations",
            tokens: estimatedTokens,
            status: "success",
            durationMs,
          }).catch(() => {});
        }

        saveRequestDetail({
          provider,
          model,
          connectionId: credentials.connectionId,
          status: success ? "success" : "error",
          endpoint: "/v1/images/generations",
          latency: { ttft: ttftMs, total: durationMs },
          request: sanitizeImagePayload(body),
          response: success ? sanitizeImagePayload(response) : { error },
        }).catch(() => {});
      },
    });

    if (result.streamed) {
      streamPending = true;
      return withConnectionMetadata(result.response, credentials);
    }

    const durationMs = Date.now() - startTime;

    if (result.success) {
      saveRequestUsage({
        provider,
        model,
        connectionId: credentials.connectionId,
        apiKey: apiKey || null,
        endpoint: "/v1/images/generations",
        tokens: estimatedTokens,
        status: "success",
        durationMs,
      }).catch(() => {});
      saveRequestDetail({
        provider,
        model,
        connectionId: credentials.connectionId,
        status: "success",
        endpoint: "/v1/images/generations",
        latency: { ttft: durationMs, total: durationMs },
        request: sanitizeImagePayload(body),
        response: sanitizeImagePayload(result.response),
      }).catch(() => {});
      return withConnectionMetadata(result.response, credentials);
    }

    saveRequestDetail({
      provider,
      model,
      connectionId: credentials.connectionId,
      status: "error",
      endpoint: "/v1/images/generations",
      latency: { ttft: durationMs, total: durationMs },
      request: sanitizeImagePayload(body),
      response: { error: result.error },
    }).catch(() => {});

    // Non-retryable request failures are account-independent; do not rotate or lock credentials.
    if (result.retryable === false) return result.response;

    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      result.status,
      result.error,
      provider,
      model,
      result.resetsAtMs
    );

    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
  } finally {
    if (!streamPending) releaseImageRequest();
  }
}
