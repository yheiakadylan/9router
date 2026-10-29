// ChatGPT Web image generation over plain HTTP (picture_v2 flow).
//
// No browser: sentinel.js mints the challenge headers, then prepare →
// conversation (SSE) → conversation poll → file download run as ordinary
// fetches with the stored cookie jar.

import { randomUUID } from "node:crypto";
import { SENTINEL_HEADERS, fetchSentinelHeaders } from "./sentinel.js";
import { resolveChatGptWebAttachments } from "./attachments.js";
import { detectImageMime, encodeDataUri, fetchImageAsBase64, parseDataUri } from "../../translator/concerns/image.js";

const MAX_SSE_BYTES = 16 * 1024 * 1024;
const MAX_CONVERSATION_BYTES = 32 * 1024 * 1024;
const SSE_DEADLINE_MS = 90000;
const POLL_INITIAL_WAIT_MS = 5000;
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 240000;
const DOWNLOAD_TIMEOUT_MS = 90000;
const UPLOAD_TIMEOUT_MS = 60000;
const CONTENT_POLICY_RE =
  /(content policy|violat(?:es|ed|ion)|can't create|cannot create|i can't generate|i cannot generate|not able to create|unable to create|safety)/i;

const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_TZ_OFFSET_MIN = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ChatGptWebImageError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ChatGptWebImageError";
    if (status) this.status = status;
  }
}

function fetchWithTimeout(url, options, timeoutMs, outerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", onAbort, { once: true });
  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onAbort);
  });
}

/** Strip `; chunk` noise and keep the cookie pairs a request actually needs. */
export function cookieHeader(storageState) {
  const cookies = Array.isArray(storageState?.cookies) ? storageState.cookies : [];
  return cookies
    .filter((cookie) => cookie?.name && typeof cookie.value === "string")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

/** Read an SSE body up to a byte cap, stopping at the deadline. */
async function readSse(response, limit, deadlineMs) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + deadlineMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      text += decoder.decode(value, { stream: true });
      if (text.length > limit) break;
    }
  } catch {
    // A deadline abort lands here — the partial text is what we want.
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

const collectIds = (text, fileIds, sedimentIds, excludeIds = null) => {
  const addUnique = (list, value) => {
    if (value && !excludeIds?.has(value) && !list.includes(value)) list.push(value);
  };
  for (const match of text.matchAll(/file-service:\/\/([A-Za-z0-9_-]+)/g)) addUnique(fileIds, match[1]);
  for (const match of text.matchAll(/\bfile_00000000[a-f0-9]{24}\b/g)) addUnique(fileIds, match[0]);
  for (const match of text.matchAll(/sediment:\/\/([A-Za-z0-9_-]+)/g)) addUnique(sedimentIds, match[1]);
};

function authHeaders({ accessToken, userAgent, cookie, sentinel }) {
  return {
    ...sentinel,
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": userAgent,
    ...(cookie ? { Cookie: cookie } : {}),
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

async function normalizeImageInputToDataUrl(input, label) {
  if (!input || typeof input !== "string") {
    throw new ChatGptWebImageError(`Invalid reference image at ${label}. Use an image URL, image data URL, or raw image base64.`, 400);
  }
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const fetched = await fetchImageAsBase64(trimmed);
    if (fetched?.url) return fetched.url;
    throw new ChatGptWebImageError(`Unable to download reference image at ${label}.`, 400);
  }
  const parsed = parseDataUri(trimmed);
  if (parsed?.mimeType?.startsWith("image/")) {
    const decoded = decodeBase64Image(parsed.base64);
    if (decoded) return encodeDataUri(decoded.mimeType, decoded.base64);
  }
  const decoded = decodeBase64Image(trimmed);
  if (decoded) return encodeDataUri(decoded.mimeType, decoded.base64);
  throw new ChatGptWebImageError(`Invalid reference image at ${label}. Use an image URL, image data URL, or raw image base64.`, 400);
}

/** Upload reference images to ChatGPT's /backend-api/files pipeline over HTTP. */
async function uploadReferenceImagesHttp(ctx, rawImages, signal) {
  if (!Array.isArray(rawImages) || rawImages.length === 0) return [];

  const sources = [];
  for (const [idx, raw] of rawImages.entries()) {
    const ref = await normalizeImageInputToDataUrl(raw, `images[${idx}]`);
    const ext = ref.startsWith("data:image/jpeg") ? "jpg" : ref.startsWith("data:image/webp") ? "webp" : "png";
    sources.push({
      kind: "image",
      ref,
      name: `reference-${idx + 1}.${ext}`,
    });
  }

  const resolved = await resolveChatGptWebAttachments(sources);
  const headers = { ...authHeaders(ctx), "Content-Type": "application/json", Accept: "application/json" };
  const uploaded = [];

  for (const attachment of resolved) {
    const regRes = await fetchWithTimeout(
      `${ctx.baseUrl}/backend-api/files`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          file_name: attachment.name,
          file_size: attachment.size,
          use_case: "multimodal",
          timezone_offset_min: DEFAULT_TZ_OFFSET_MIN,
          reset_rate_limits: false,
          supports_direct_azure_multipart: true,
          mime_type: attachment.mimeType,
          entry_surface: "chat_composer",
          selection_method: "file_picker",
          client_resolved_mime_type: attachment.mimeType,
          mime_resolution_source: "filename_extension",
          store_in_library: false,
        }),
      },
      UPLOAD_TIMEOUT_MS,
      signal
    );
    if (!regRes.ok) {
      throw new ChatGptWebImageError(`ChatGPT reference image registration failed (HTTP ${regRes.status})`, regRes.status || 502);
    }
    const regPayload = await regRes.json().catch(() => null);
    if (!regPayload?.file_id || !regPayload?.upload_url) {
      throw new ChatGptWebImageError("ChatGPT reference image registration returned an invalid response", 502);
    }

    const putRes = await fetchWithTimeout(
      regPayload.upload_url,
      {
        method: "PUT",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": attachment.mimeType,
          "x-ms-blob-type": "BlockBlob",
          "x-ms-version": "2020-04-08",
        },
        body: new Uint8Array(attachment.data),
      },
      UPLOAD_TIMEOUT_MS,
      signal
    );
    if (!putRes.ok) {
      throw new ChatGptWebImageError(`ChatGPT reference image upload failed (HTTP ${putRes.status})`, putRes.status || 502);
    }

    const procRes = await fetchWithTimeout(
      `${ctx.baseUrl}/backend-api/files/process_upload_stream`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          file_id: regPayload.file_id,
          use_case: "multimodal",
          index_for_retrieval: false,
          file_name: attachment.name,
          entry_surface: "chat_composer",
          metadata: {
            store_in_library: false,
            is_temporary_chat: true,
            library_eligibility_reason: "eligible",
            is_project_thread: false,
          },
        }),
      },
      UPLOAD_TIMEOUT_MS,
      signal
    );
    await procRes.text().catch(() => "");
    if (!procRes.ok) {
      throw new ChatGptWebImageError(`ChatGPT reference image processing failed (HTTP ${procRes.status})`, procRes.status || 502);
    }

    uploaded.push({
      fileId: regPayload.file_id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
    });
  }

  return uploaded;
}

/** prepare → conversation SSE. Returns the conversation id plus any ids seen. */
async function runImageConversation(ctx, prompt, sizeHint, uploadedImages, excludeIds, signal) {
  const { baseUrl } = ctx;
  const headers = authHeaders(ctx);
  const text = sizeHint ? `${prompt} (aspect ratio ${sizeHint})` : prompt;

  const content = uploadedImages.length > 0
    ? {
        content_type: "multimodal_text",
        parts: [
          ...uploadedImages.map((item) => ({
            content_type: "image_asset_pointer",
            asset_pointer: `sediment://${item.fileId}`,
            size_bytes: item.size,
            width: item.width,
            height: item.height,
          })),
          text,
        ],
      }
    : { content_type: "text", parts: [text] };

  const attachments = uploadedImages.map((item) => ({
    id: item.fileId,
    size: item.size,
    name: item.name,
    mime_type: item.mimeType,
    width: item.width,
    height: item.height,
    source: "local",
    is_big_paste: false,
  }));

  const prepare = await fetchWithTimeout(`${baseUrl}/backend-api/f/conversation/prepare`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      action: "next",
      fork_from_shared_post: false,
      parent_message_id: randomUUID(),
      model: "auto",
      client_prepare_state: "success",
      timezone_offset_min: DEFAULT_TZ_OFFSET_MIN,
      timezone: DEFAULT_TIMEZONE,
      conversation_mode: { kind: "primary_assistant" },
      system_hints: ["picture_v2"],
      partial_query: {
        id: randomUUID(),
        author: { role: "user" },
        content,
      },
      supports_buffering: true,
      supported_encodings: ["v1"],
      client_contextual_info: { app_name: "chatgpt.com" },
    }),
  }, 60000, signal);
  if (!prepare.ok) {
    throw new ChatGptWebImageError(`ChatGPT prepare failed (HTTP ${prepare.status})`, prepare.status || 502);
  }
  const prepareJson = await prepare.json().catch(() => null);
  const conduitToken = prepareJson?.conduit_token || "";

  const conversation = await fetchWithTimeout(`${baseUrl}/backend-api/f/conversation`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-Conduit-Token": conduitToken,
      "X-Oai-Turn-Trace-Id": randomUUID(),
    },
    body: JSON.stringify({
      action: "next",
      messages: [{
        id: randomUUID(),
        author: { role: "user" },
        create_time: Date.now() / 1000,
        content,
        metadata: {
          developer_mode_connector_ids: [],
          selected_github_repos: [],
          selected_all_github_repos: false,
          system_hints: ["picture_v2"],
          ...(attachments.length > 0 ? { attachments } : {}),
          serialization_metadata: { custom_symbol_offsets: [] },
        },
      }],
      parent_message_id: randomUUID(),
      model: "auto",
      client_prepare_state: "sent",
      timezone_offset_min: DEFAULT_TZ_OFFSET_MIN,
      timezone: DEFAULT_TIMEZONE,
      conversation_mode: { kind: "primary_assistant" },
      enable_message_followups: true,
      system_hints: ["picture_v2"],
      supports_buffering: true,
      supported_encodings: ["v1"],
      client_contextual_info: {
        is_dark_mode: false,
        time_since_loaded: 1200,
        page_height: 1072,
        page_width: 1724,
        pixel_ratio: 1.2,
        screen_height: 1440,
        screen_width: 2560,
        app_name: "chatgpt.com",
      },
      paragen_cot_summary_display_override: "allow",
      force_parallel_switch: "auto",
    }),
  }, SSE_DEADLINE_MS + 15000, signal);
  if (!conversation.ok) {
    throw new ChatGptWebImageError(`ChatGPT conversation failed (HTTP ${conversation.status})`, conversation.status || 502);
  }
  const sseText = await readSse(conversation, MAX_SSE_BYTES, SSE_DEADLINE_MS);

  const conversationId = (sseText.match(/"conversation_id"\s*:\s*"([0-9a-f-]{36})"/) || [])[1] || "";
  const fileIds = [];
  const sedimentIds = [];
  collectIds(sseText, fileIds, sedimentIds, excludeIds);
  return { conversationId, fileIds, sedimentIds };
}

/** Poll the conversation document until an image_gen record shows up. */
async function pollConversationImages(ctx, conversationId, initial, excludeIds, { signal, log }) {
  const started = Date.now();
  const fileIds = [...initial.fileIds];
  const sedimentIds = [...initial.sedimentIds];
  const headers = { ...authHeaders(ctx), Accept: "application/json" };

  await sleep(POLL_INITIAL_WAIT_MS);
  while (Date.now() - started <= POLL_TIMEOUT_MS) {
    if (signal?.aborted) throw new Error("Request aborted");

    const res = await fetchWithTimeout(`${ctx.baseUrl}/backend-api/conversation/${conversationId}`, { headers }, 30000, signal)
      .catch(() => null);
    if (!res?.ok) {
      log?.debug?.("CGPT-WEB-IMG", `conversation poll status ${res?.status ?? "network"}, retrying`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_CONVERSATION_BYTES) {
      throw new ChatGptWebImageError("ChatGPT conversation document is unexpectedly large", 502);
    }
    const text = await res.text().catch(() => "");
    if (text.length > MAX_CONVERSATION_BYTES) {
      throw new ChatGptWebImageError("ChatGPT conversation document is unexpectedly large", 502);
    }

    collectIds(text, fileIds, sedimentIds, excludeIds);
    if (fileIds.length > 0 || sedimentIds.length > 0) {
      return { fileIds: fileIds.filter((id) => id !== "file_upload"), sedimentIds };
    }
    if (CONTENT_POLICY_RE.test(text) && /"is_error"\s*:\s*true/.test(text)) {
      throw new ChatGptWebImageError("ChatGPT refused the image request (content policy)", 400);
    }
    // A depleted account reports a tool-level rate limit instead of an image:
    // fail fast so the shared fallback loop can try the next connection.
    if (/ChatGPTAgentToolRateLimitException|Free plan limit for image generation/i.test(text)) {
      throw new ChatGptWebImageError(
        "ChatGPT account has hit its image generation quota — add another account or wait for the reset",
        429
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new ChatGptWebImageError("ChatGPT image generation timed out", 504);
}

function isFirstPartyDownloadUrl(url, baseUrl) {
  try {
    const parsed = new URL(url, baseUrl);
    const baseHost = new URL(baseUrl).hostname.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    return host === baseHost || host.endsWith(".chatgpt.com") || host === "chatgpt.com";
  } catch {
    return false;
  }
}

async function downloadUrl(ctx, rawUrl, signal) {
  const resolvedUrl = rawUrl.startsWith("/") ? `${ctx.baseUrl}${rawUrl}` : rawUrl;
  const firstParty = isFirstPartyDownloadUrl(resolvedUrl, ctx.baseUrl);
  const firstPartyHeaders = {
    Authorization: `Bearer ${ctx.accessToken}`,
    "User-Agent": ctx.userAgent,
    Referer: `${ctx.baseUrl}/`,
    ...(ctx.cookie ? { Cookie: ctx.cookie } : {}),
  };

  let res = await fetchWithTimeout(
    resolvedUrl,
    firstParty
      ? { headers: firstPartyHeaders, redirect: "manual" }
      : { headers: { "User-Agent": ctx.userAgent } },
    DOWNLOAD_TIMEOUT_MS,
    signal
  ).catch(() => null);
  if (!res) return null;

  // Follow a redirect from first-party estuary/content to an external signed blob URL without leaking Authorization
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) return null;
    const redirectUrl = new URL(location, resolvedUrl).toString();
    const redirectFirstParty = isFirstPartyDownloadUrl(redirectUrl, ctx.baseUrl);
    res = await fetchWithTimeout(
      redirectUrl,
      redirectFirstParty
        ? { headers: firstPartyHeaders }
        : { headers: { "User-Agent": ctx.userAgent } },
      DOWNLOAD_TIMEOUT_MS,
      signal
    ).catch(() => null);
    if (!res) return null;
  }

  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) return null;
  return {
    b64: buffer.toString("base64"),
    mime: (res.headers.get("content-type") || "image/png").split(";")[0],
  };
}

/** Resolve one generated id into { b64, mime }. */
async function downloadGeneratedImage(ctx, conversationId, { fileIds, sedimentIds }, signal) {
  const jsonHeaders = { ...authHeaders(ctx), Accept: "application/json" };

  for (const fileId of fileIds) {
    const res = await fetchWithTimeout(`${ctx.baseUrl}/backend-api/files/${fileId}/download`, { headers: jsonHeaders }, 60000, signal)
      .catch(() => null);
    if (!res?.ok) continue;
    const body = await res.json().catch(() => null);
    const url = body?.download_url || body?.url || "";
    if (!url) continue;
    const media = await downloadUrl(ctx, url, signal);
    if (media) return media;
  }

  for (const sedimentId of sedimentIds) {
    const res = await fetchWithTimeout(
      `${ctx.baseUrl}/backend-api/conversation/${conversationId}/attachment/${sedimentId}/download`,
      { headers: jsonHeaders },
      60000,
      signal
    ).catch(() => null);
    if (!res?.ok) continue;
    const body = await res.json().catch(() => null);
    const url = body?.download_url || body?.url || "";
    if (!url) continue;
    const media = await downloadUrl(ctx, url, signal);
    if (media) return media;
  }

  throw new ChatGptWebImageError("ChatGPT image generation produced no downloadable file", 502);
}

/**
 * Generate one image and return base64 bytes. Plain HTTP — no browser.
 *
 * @param {object} options
 * @param {string} options.baseUrl - e.g. https://chatgpt.com
 * @param {string} options.accessToken - from /api/auth/session
 * @param {string} options.cookie - Cookie header from the stored credential
 * @param {string} options.userAgent
 * @param {string} options.prompt
 * @param {string} [options.sizeHint]
 * @param {string[]} [options.images]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{b64: string, mime: string}>}
 */
export async function generateChatGptWebImageHttp({
  baseUrl,
  accessToken,
  cookie,
  userAgent,
  prompt,
  sizeHint,
  images,
  signal,
  log,
}) {
  if (!accessToken) throw new ChatGptWebImageError("ChatGPT session has no access token", 401);
  if (signal?.aborted) throw new Error("Request aborted");

  const sentinel = await fetchSentinelHeaders({ baseUrl, accessToken, userAgent, signal });
  const ctx = { baseUrl, accessToken, cookie, userAgent, sentinel };

  const uploadedImages = await uploadReferenceImagesHttp(ctx, images, signal);
  const excludeIds = new Set(uploadedImages.map((item) => item.fileId));

  const initial = await runImageConversation(ctx, prompt, sizeHint, uploadedImages, excludeIds, signal);
  if (!initial.conversationId && initial.fileIds.length === 0 && initial.sedimentIds.length === 0) {
    throw new ChatGptWebImageError("ChatGPT image conversation produced no conversation id", 502);
  }
  const ids = initial.fileIds.length > 0 || initial.sedimentIds.length > 0
    ? initial
    : await pollConversationImages(ctx, initial.conversationId, initial, excludeIds, { signal, log });

  return downloadGeneratedImage(ctx, initial.conversationId, ids, signal);
}

export { SENTINEL_HEADERS };
