import { randomUUID } from "node:crypto";
import { getImageStudioAssetDataUrl, saveImageStudioAsset, updateImageStudioConversation } from "@/lib/db";
import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { handleImageGeneration } from "@/sse/handlers/imageGeneration.js";

const jobs = globalThis.__imageStudioJobs || new Map();
globalThis.__imageStudioJobs = jobs;
let translatorsReady = false;

const IMAGE_AGENT_TOOLS = [{
  type: "function",
  function: {
    name: "generate_image",
    description: "Generate exactly one image from this prompt.",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
}];

const AGENT_SYSTEM_PROMPT = `You are a helpful ChatGPT-style assistant with optional image generation.
Answer normal questions in text. Call generate_image only when the user clearly asks to create, edit, transform, or produce an image.
If the user asks for multiple separate images, call generate_image once for every separate output image.
Preserve all visual requirements in the image prompt. Also provide a short natural text reply while the images are being generated.`;

async function ensureTranslators() {
  if (!translatorsReady) {
    await initTranslators();
    translatorsReady = true;
  }
}

async function buildMessages(messages) {
  return await Promise.all([
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    ...messages.slice(-12).map((message) => {
      if (message.role !== "user") return { role: message.role, content: message.content || "" };
      if (!message.references?.length) return { role: "user", content: message.content || "" };
      return Promise.all(message.references.map(resolveReference)).then((references) => ({
        role: "user",
        content: [
          { type: "text", text: message.content || "" },
          ...references.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      }));
    }),
  ]);
}

function parseToolCalls(payload) {
  return payload?.choices?.[0]?.message?.tool_calls
    || (payload?.choices?.[0]?.message?.function_call ? [{ function: payload.choices[0].message.function_call }] : []);
}

function parseToolPrompt(toolCall, fallback) {
  try {
    const args = typeof toolCall.function?.arguments === "object"
      ? toolCall.function.arguments
      : JSON.parse(toolCall.function?.arguments || "{}");
    return typeof args.prompt === "string" && args.prompt.trim() ? args.prompt.trim() : fallback;
  } catch {
    return fallback;
  }
}

async function resolveReference(value) {
  if (typeof value !== "string") return value;
  const match = value.match(/^\/api\/image-studio\/assets\/([^/?#]+)/);
  if (!match) return value;
  return await getImageStudioAssetDataUrl(decodeURIComponent(match[1])) || value;
}

function detectImageMime(bytes, fallback = "") {
  const declared = String(fallback).split(";", 1)[0].toLowerCase();
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(declared)) return declared;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (bytes.subarray(0, 4).toString() === "GIF8") return "image/gif";
  throw new Error("Generated image has an unsupported format");
}

async function persistImageResult(job, item) {
  if (item.url?.startsWith("/api/image-studio/assets/")) return item.url;
  let bytes;
  let mimeType = item.mime_type || item.mimeType || "";
  if (item.b64_json) {
    bytes = Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    const response = await fetch(item.url, { signal: job.controller.signal });
    if (!response.ok) throw new Error(`Failed to download generated image (HTTP ${response.status})`);
    mimeType ||= response.headers.get("content-type") || "";
    bytes = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error("No image returned");
  }
  const asset = await saveImageStudioAsset({
    conversationId: job.conversationId,
    mimeType: detectImageMime(bytes, mimeType),
    bytes,
  });
  return asset.url;
}

async function callChat(job) {
  job.controller.signal.throwIfAborted();
  await ensureTranslators();
  job.controller.signal.throwIfAborted();
  const messages = await buildMessages(job.messages);
  job.controller.signal.throwIfAborted();
  const headers = { "Content-Type": "application/json", Accept: "application/json", "x-image-studio-conversation-id": job.conversationId };
  if (job.apiKey) headers.Authorization = `Bearer ${job.apiKey}`;
  const request = new Request("http://image-studio.local/api/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: job.textModel,
      messages,
      tools: IMAGE_AGENT_TOOLS,
      tool_choice: "auto",
      parallel_tool_calls: true,
      stream: false,
    }),
    signal: job.controller.signal,
  });
  const response = await handleChat(request);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Chat model failed (HTTP ${response.status})`);
  return payload;
}

async function callImage(job, prompt, references) {
  job.controller.signal.throwIfAborted();
  const resolvedReferences = await Promise.all((references || []).map(resolveReference));
  job.controller.signal.throwIfAborted();
  const body = {
    model: job.imageModel,
    prompt,
    output_format: "png",
    ...(resolvedReferences.length > 1 ? { images: resolvedReferences } : {}),
    ...(resolvedReferences.length === 1 ? { image: resolvedReferences[0] } : {}),
  };
  const headers = { "Content-Type": "application/json", Accept: "application/json", "x-image-studio-conversation-id": job.conversationId };
  if (job.apiKey) headers.Authorization = `Bearer ${job.apiKey}`;
  const response = await handleImageGeneration(new Request("http://image-studio.local/api/v1/images/generations", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: job.controller.signal,
  }));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Image generation failed (HTTP ${response.status})`);
  const item = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!item) throw new Error("No image returned");
  return { ...item, url: await persistImageResult(job, item), b64_json: undefined };
}

async function callImageWithRetries(job, prompt, references) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await callImage(job, prompt, references);
    } catch (error) {
      lastError = error;
      if (error?.name === "AbortError" || attempt === 4) throw error;
    }
  }
  throw lastError || new Error("Image generation failed");
}

function patchAssistant(messages, assistantId, patch) {
  return messages.map((message) => message.id === assistantId ? { ...message, ...patch } : message);
}

function patchImage(messages, assistantId, imageId, patch) {
  return messages.map((message) => message.id === assistantId
    ? { ...message, images: (message.images || []).map((image) => image.id === imageId ? { ...image, ...patch } : image) }
    : message);
}

async function persist(job, messages, status) {
  job.messages = messages;
  const snapshot = messages;
  job.persistQueue = (job.persistQueue || Promise.resolve())
    .catch(() => {})
    .then(() => updateImageStudioConversation(job.conversationId, { messages: snapshot, status }));
  await job.persistQueue;
}

async function runRetry(job) {
  const message = job.messages.find((entry) => entry.id === job.retry.messageId);
  const image = message?.images?.find((entry) => entry.id === job.retry.imageId);
  if (!message || !image) throw new Error("Image to retry was not found");
  const messageIndex = job.messages.findIndex((entry) => entry.id === message.id);
  const references = job.messages[messageIndex - 1]?.references || [];
  const startedAt = Date.now();
  let messages = patchAssistant(job.messages, message.id, { phase: "generating", generationStartedAt: startedAt });
  messages = patchImage(messages, message.id, image.id, { status: "generating", attempt: 1, startedAt, error: "" });
  await persist(job, messages, "generating");
  const result = await callImageWithRetries(job, image.prompt, references);
  const completedAt = Date.now();
  messages = patchImage(messages, message.id, image.id, {
    status: "done",
    src: result.url,
    error: "",
    completedAt,
    elapsedMs: completedAt - startedAt,
  });
  messages = patchAssistant(messages, message.id, { phase: "done", generationCompletedAt: completedAt });
  await persist(job, messages, "success");
}

async function runJob(job) {
  try {
    if (job.retry) {
      await runRetry(job);
      return;
    }
    const chatPayload = await callChat(job);
    const assistant = chatPayload?.choices?.[0]?.message || {};
    let messages = patchAssistant(job.messages, job.assistantId, {
      content: assistant.content || "",
      phase: "thinking",
    });
    await persist(job, messages, "generating");

    const toolCalls = parseToolCalls(chatPayload).filter((call) => call?.function?.name === "generate_image");
    if (toolCalls.length === 0) {
      messages = patchAssistant(messages, job.assistantId, { phase: "done", generationCompletedAt: Date.now() });
      await persist(job, messages, "success");
      return;
    }

    const planned = toolCalls.map((toolCall) => ({
      id: randomUUID(),
      prompt: parseToolPrompt(toolCall, job.userPrompt),
      status: "generating",
      attempt: 1,
      startedAt: Date.now(),
      elapsedMs: 0,
    }));
    messages = patchAssistant(messages, job.assistantId, {
      phase: "generating",
      images: planned,
      generationStartedAt: planned[0].startedAt,
    });
    await persist(job, messages, "generating");

    await Promise.all(planned.map(async (image) => {
      try {
        const result = await callImageWithRetries(job, image.prompt, job.userReferences);
        const completedAt = Date.now();
        messages = patchImage(messages, job.assistantId, image.id, {
          status: "done",
          src: result.url,
          error: "",
          completedAt,
          elapsedMs: completedAt - image.startedAt,
        });
      } catch (error) {
        const completedAt = Date.now();
        messages = patchImage(messages, job.assistantId, image.id, {
          status: "error",
          error: error.message || "Image generation failed",
          completedAt,
          elapsedMs: completedAt - image.startedAt,
        });
      }
      await persist(job, messages, "generating");
    }));

    const completedImages = messages.find((message) => message.id === job.assistantId)?.images || [];
    messages = patchAssistant(messages, job.assistantId, { phase: "done", generationCompletedAt: Date.now() });
    await persist(job, messages, completedImages.some((image) => image.status === "done") ? "success" : "error");
  } catch (error) {
    const stopped = error?.name === "AbortError" || job.controller.signal.aborted;
    const messages = patchAssistant(job.messages, job.assistantId, {
      phase: stopped ? "done" : "error",
      ...(!stopped ? { content: error.message || "Request failed" } : {}),
      generationCompletedAt: Date.now(),
      images: (job.messages.find((message) => message.id === job.assistantId)?.images || []).map((image) => image.status === "generating"
        ? { ...image, status: "error", error: stopped ? "Generation stopped" : error.message || "Generation failed" }
        : image),
    });
    await persist(job, messages, "error");
  } finally {
    jobs.delete(job.id);
  }
}

export function getActiveImageStudioJobConversationIds() {
  return [...new Set([...jobs.values()].map((job) => job.conversationId))];
}

export function getActiveImageStudioJobs() {
  return [...jobs.values()].map((job) => ({ id: job.id, conversationId: job.conversationId }));
}

export async function startImageStudioJob(input) {
  if ([...jobs.values()].some((job) => job.conversationId === input.conversationId)) {
    const error = new Error("This conversation already has a running job");
    error.status = 409;
    throw error;
  }
  const id = randomUUID();
  const job = { ...input, id, controller: new AbortController(), messages: input.messages || [] };
  jobs.set(id, job);
  try {
    const conversation = await updateImageStudioConversation(job.conversationId, {
      title: job.title,
      status: "generating",
      textModel: job.textModel,
      imageModel: job.imageModel,
      messages: job.messages,
    });
    if (!conversation) {
      const error = new Error("Conversation not found");
      error.status = 404;
      throw error;
    }
  } catch (error) {
    jobs.delete(id);
    throw error;
  }
  void runJob(job);
  return id;
}

export function cancelImageStudioJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.controller.abort();
  return true;
}
