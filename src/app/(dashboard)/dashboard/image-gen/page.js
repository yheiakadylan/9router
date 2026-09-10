"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/shared/components";
import { getModelKind, getModelsByProviderId } from "@/shared/constants/models";
import { getProviderAlias, getProvidersByKind } from "@/shared/constants/providers";
import { isImageGenEnabled, subscribeImageGenAccess } from "@/shared/utils/imageGenAccess";

const CHAT_ENDPOINT = "/api/v1/chat/completions";
const IMAGE_ENDPOINT = "/api/v1/images/generations";
const MAX_IMAGE_RETRIES = 3;
const MAX_IMAGE_ATTEMPTS = 4;

const IMAGE_AGENT_TOOLS = [{
  type: "function",
  function: {
    name: "generate_image",
    description: "Generate exactly one image from this prompt. Call this tool once for every separate output image; each call must have a distinct self-contained prompt.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Complete visual prompt for the image." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
}];

const AGENT_SYSTEM_PROMPT = `You are a helpful ChatGPT-style assistant with optional image generation.
Answer normal questions in text. Call generate_image only when the user clearly asks to create, edit, transform, or produce an image.
If the user asks for multiple separate images, call generate_image once for every output image and make each prompt self-contained and distinct. For example, "dog, cat, bird, mouse, pig" means five tool calls and five image requests, one subject per prompt. Never reuse one prompt five times. A collage, grid, contact sheet, or single scene is one image unless separate files are explicitly requested.
Preserve all visual requirements in the image prompt. Also provide a short natural text reply while the images are being generated.`;

function createId(prefix) {
  return globalThis.crypto?.randomUUID?.() || `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

function imageSrc(value) {
  if (!value) return "";
  if (/^(data:image\/|https?:\/\/)/i.test(value)) return value;
  return `data:image/png;base64,${value}`;
}

function formatDuration(value) {
  const seconds = Math.max(0, value || 0) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`;
}

function downloadImages(images) {
  images.filter((image) => image.status === "done" && image.src).forEach((image, index) => {
    const link = document.createElement("a");
    link.href = image.src;
    link.download = `9router-image-${index + 1}.png`;
    link.click();
  });
}

const INLINE_REGEX = /(\[[^\]]+\]\([^)]+\)|\*\*\*[^*]+\*\*\*|___[^_]+___|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|==[^=]+==|\+\+[^+]+\+\+|`[^`]+`|\*[^*]+\*|_[^_]+_|\^[^^]+\^|~[^~]+~)/g;

function renderInline(value) {
  if (!value) return null;
  const parts = String(value).split(INLINE_REGEX);
  return parts.map((part, partIndex) => {
    if (!part) return null;
    // [text](url)
    if (part.startsWith("[") && part.includes("](") && part.endsWith(")")) {
      const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (match) {
        return (
          <a
            key={partIndex}
            href={match[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:opacity-80 break-all"
          >
            {match[1]}
          </a>
        );
      }
    }
    // ***bold italic*** or ___bold italic___
    if ((part.startsWith("***") && part.endsWith("***")) || (part.startsWith("___") && part.endsWith("___"))) {
      return <strong key={partIndex} className="font-bold"><em>{part.slice(3, -3)}</em></strong>;
    }
    // **bold** or __bold__
    if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
      return <strong key={partIndex} className="font-bold">{part.slice(2, -2)}</strong>;
    }
    // ~~strikethrough~~
    if (part.startsWith("~~") && part.endsWith("~~")) {
      return <del key={partIndex} className="line-through opacity-70">{part.slice(2, -2)}</del>;
    }
    // ==highlight==
    if (part.startsWith("==") && part.endsWith("==")) {
      return <mark key={partIndex} className="rounded bg-yellow-300/30 dark:bg-yellow-500/30 px-1 py-0.5 text-inherit">{part.slice(2, -2)}</mark>;
    }
    // ++underline++
    if (part.startsWith("++") && part.endsWith("++")) {
      return <u key={partIndex} className="underline underline-offset-2">{part.slice(2, -2)}</u>;
    }
    // `inline code`
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={partIndex} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.88em] text-primary">{part.slice(1, -1)}</code>;
    }
    // *italic* or _italic_
    if ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_"))) {
      return <em key={partIndex} className="italic">{part.slice(1, -1)}</em>;
    }
    // ^superscript^
    if (part.startsWith("^") && part.endsWith("^")) {
      return <sup key={partIndex} className="text-[0.75em]">{part.slice(1, -1)}</sup>;
    }
    // ~subscript~
    if (part.startsWith("~") && part.endsWith("~")) {
      return <sub key={partIndex} className="text-[0.75em]">{part.slice(1, -1)}</sub>;
    }
    return <span key={partIndex}>{part}</span>;
  });
}

function MarkdownText({ content }) {
  const lines = String(content || "").split(/\r?\n/);
  const elements = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 1. Fenced Code Block (```lang ... ```)
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      elements.push(
        <div key={elements.length} className="my-2 overflow-hidden rounded-lg border border-border bg-surface-2">
          {lang && (
            <div className="border-b border-border/50 bg-surface-3/40 px-3 py-1 text-[11px] font-mono text-text-muted">
              {lang}
            </div>
          )}
          <pre className="overflow-x-auto p-3 font-mono text-xs leading-5">
            <code>{codeLines.join("\n")}</code>
          </pre>
        </div>
      );
      continue;
    }

    // 2. Table (| col | col |)
    if (/^\s*\|(.+)\|\s*$/.test(line)) {
      const tableLines = [line];
      while (i + 1 < lines.length && /^\s*\|(.+)\|\s*$/.test(lines[i + 1])) {
        i++;
        tableLines.push(lines[i]);
      }
      i++;
      const parsedRows = tableLines.map((r) =>
        r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim())
      );
      const isSep = (row) => row.every((c) => /^:?-+:?$/.test(c));
      const headerRow = parsedRows[0];
      const dataRows = parsedRows.slice(1).filter((r) => !isSep(r));
      elements.push(
        <div key={elements.length} className="my-2 overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full text-xs text-left">
            <thead className="border-b border-border bg-surface-2 font-semibold text-text-main">
              <tr>
                {headerRow.map((cell, cIdx) => (
                  <th key={cIdx} className="px-3 py-2">{renderInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle bg-background">
              {dataRows.map((row, rIdx) => (
                <tr key={rIdx} className="hover:bg-surface-2/30">
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} className="px-3 py-2">{renderInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // 3. Blockquote (> text)
    const quoteMatch = line.match(/^\s*>+\s?(.*)$/);
    if (quoteMatch) {
      const quoteLines = [quoteMatch[1]];
      while (i + 1 < lines.length && /^\s*>+\s?/.test(lines[i + 1])) {
        i++;
        quoteLines.push(lines[i].replace(/^\s*>+\s?/, ""));
      }
      i++;
      elements.push(
        <blockquote key={elements.length} className="my-1.5 border-l-4 border-primary/60 bg-surface-2/40 rounded-r-md px-3 py-1.5 italic text-text-muted">
          {quoteLines.map((qLine, qIdx) => (
            <p key={qIdx} className={qIdx > 0 ? "mt-1" : ""}>
              {renderInline(qLine)}
            </p>
          ))}
        </blockquote>
      );
      continue;
    }

    // 4. Horizontal Rule (---, ***, ___)
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      elements.push(<hr key={elements.length} className="my-2.5 border-border" />);
      i++;
      continue;
    }

    // 5. Empty line
    if (!line.trim()) {
      elements.push(<div key={elements.length} className="h-1.5" />);
      i++;
      continue;
    }

    // 6. Headings (# H1 to ###### H6)
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      if (level === 1) {
        elements.push(<h1 key={elements.length} className="text-base font-bold text-text-main mt-2 mb-0.5">{renderInline(text)}</h1>);
      } else if (level === 2) {
        elements.push(<h2 key={elements.length} className="text-sm font-bold text-text-main mt-1.5 mb-0.5">{renderInline(text)}</h2>);
      } else if (level === 3) {
        elements.push(<h3 key={elements.length} className="text-xs font-semibold text-text-main mt-1">{renderInline(text)}</h3>);
      } else {
        elements.push(<h4 key={elements.length} className="text-xs font-medium text-text-muted mt-0.5 uppercase tracking-wide">{renderInline(text)}</h4>);
      }
      i++;
      continue;
    }

    // 7. Task list (- [ ] or - [x])
    const taskMatch = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (taskMatch) {
      const checked = taskMatch[1].toLowerCase() === "x";
      elements.push(
        <div key={elements.length} className="flex items-center gap-2 pl-2">
          <input type="checkbox" checked={checked} readOnly className="size-3.5 rounded accent-primary pointer-events-none" />
          <span className={checked ? "line-through opacity-70" : ""}>{renderInline(taskMatch[2])}</span>
        </div>
      );
      i++;
      continue;
    }

    // 8. Ordered list (1. item)
    const orderedMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (orderedMatch) {
      elements.push(
        <div key={elements.length} className="flex items-start gap-2 pl-2">
          <span className="shrink-0 select-none text-text-muted text-xs font-mono">{orderedMatch[1]}.</span>
          <div className="flex-1">{renderInline(orderedMatch[2])}</div>
        </div>
      );
      i++;
      continue;
    }

    // 9. Bullet list (- item, * item, + item)
    const bulletMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bulletMatch) {
      elements.push(
        <div key={elements.length} className="flex items-start gap-2 pl-2">
          <span className="shrink-0 select-none text-primary">•</span>
          <div className="flex-1">{renderInline(bulletMatch[1])}</div>
        </div>
      );
      i++;
      continue;
    }

    // 10. Single-line code on its own line (`code`)
    const codeMatch = line.match(/^\s*`([^`]+)`\s*$/);
    if (codeMatch) {
      elements.push(
        <pre key={elements.length} className="overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 text-xs font-mono">
          <code>{codeMatch[1]}</code>
        </pre>
      );
      i++;
      continue;
    }

    // 11. Normal paragraph
    elements.push(
      <p key={elements.length}>{renderInline(line)}</p>
    );
    i++;
  }

  return <div className="space-y-1.5">{elements}</div>;
}

function ImageGeneratingPlaceholder({ label, attempt = 1 }) {
  return <div className="relative flex aspect-square flex-col items-center justify-center overflow-hidden bg-surface-2 text-center text-xs text-text-muted">
    <div className="image-generation-shimmer absolute inset-y-0 left-[-55%] w-[210%]" aria-hidden="true" />
    <div className="animate-border-glow absolute inset-4 rounded-xl border border-primary/35 bg-white/20" aria-hidden="true" />
    <div className="relative flex flex-col items-center gap-2 rounded-xl bg-background/80 px-5 py-4 shadow-sm">
      <span className="material-symbols-outlined animate-pulse-glow text-3xl text-primary">auto_awesome</span>
      <span className="font-medium text-text-main">{label}</span>
      <span className="text-[11px]">{attempt > 1 ? `Retrying automatically ${attempt - 1}/${MAX_IMAGE_RETRIES}` : "Creating your image"}</span>
      <span className="h-1 w-28 overflow-hidden rounded-full bg-border-subtle" aria-hidden="true"><span className="image-generation-progress block h-full w-1/2 rounded-full bg-primary" /></span>
      <span className="flex gap-1" aria-label="Image generation in progress">
        {[1, 2, 3].map((dot) => <span key={dot} className="image-generation-dot size-1.5 rounded-full bg-primary" />)}
      </span>
    </div>
  </div>;
}

function getImageItems(payload) {
  const data = payload?.data?.data || payload?.data || [];
  return Array.isArray(data) ? data : [];
}

function modelOptions(connections, disabled, kind, modelOrders = {}) {
  const activeProviders = new Set(
    connections.filter((connection) => connection.isActive !== false).map((connection) => connection.provider),
  );
  const providers = getProvidersByKind(kind);
  return providers.flatMap((provider) => {
    if (!provider.noAuth && activeProviders.size > 0 && !activeProviders.has(provider.id)) return [];
    const alias = getProviderAlias(provider.id) || provider.id;
    const providerOrder = modelOrders[`${alias}:${kind}`] || modelOrders[`${provider.id}:${kind}`] || [];
    const list = getModelsByProviderId(provider.id)
      .filter((model) => kind === "image" ? getModelKind(model) === "image" : getModelKind(model) !== "image")
      .filter((model) => !(disabled[alias] || disabled[provider.id] || []).includes(model.id))
      .map((model) => ({
        id: `${alias}/${model.id}`,
        name: model.name || model.id,
        rawId: model.id,
        provider: provider.id,
        alias,
      }));

    if (Array.isArray(providerOrder) && providerOrder.length > 0) {
      list.sort((a, b) => {
        const indexA = providerOrder.indexOf(a.rawId);
        const indexB = providerOrder.indexOf(b.rawId);
        if (indexA !== -1 && indexB !== -1) return indexA - indexB;
        if (indexA !== -1) return -1;
        if (indexB !== -1) return 1;
        return 0;
      });
    }

    return list;
  });
}

function appendToolCall(toolCalls, delta) {
  for (const call of delta || []) {
    const index = Number.isInteger(call.index) ? call.index : toolCalls.length;
    const current = toolCalls[index] || { name: "", arguments: "" };
    current.name += call.function?.name || "";
    const args = call.function?.arguments;
    current.arguments += typeof args === "string" ? args : args ? JSON.stringify(args) : "";
    toolCalls[index] = current;
  }
}

async function consumeChatResponse(response, onText, signal) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    const payload = await response.json();
    const message = payload?.choices?.[0]?.message || {};
    return {
      text: message.content || "",
      toolCalls: message.tool_calls || (message.function_call ? [{ function: message.function_call }] : []),
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const toolCalls = [];
  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(raw); } catch { continue; }
      const delta = chunk.choices?.[0]?.delta || {};
      const textDelta = typeof delta.content === "string" ? delta.content : "";
      if (textDelta) {
        text += textDelta;
        onText?.(text);
      }
      appendToolCall(toolCalls, delta.tool_calls || (delta.function_call ? [{ function: delta.function_call }] : []));
    }
    if (done) break;
  }
  return { text, toolCalls };
}

async function generateOneImage({ model, prompt, references, apiKey, signal }) {
  const body = {
    model,
    prompt,
    output_format: "png",
    ...(references.length > 1 ? { images: references } : {}),
    ...(references.length === 1 ? { image: references[0] } : {}),
  };
  const headers = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(IMAGE_ENDPOINT, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.message || payload?.error || `Image generation failed (HTTP ${response.status})`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream") || !response.body) return getImageItems(await response.json());

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalPayload = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = done ? "" : blocks.pop() || "";
    for (const block of blocks) {
      let eventName = "";
      let data = "";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let payload;
      try { payload = JSON.parse(data); } catch { continue; }
      if (eventName === "error") throw new Error(payload.message || "Image generation failed");
      if (eventName === "done") finalPayload = payload;
    }
    if (done) break;
  }
  return getImageItems(finalPayload);
}

async function generateImageWithRetries(options, onAttempt) {
  for (let attempt = 1; attempt <= MAX_IMAGE_ATTEMPTS; attempt += 1) {
    onAttempt?.(attempt);
    try {
      const first = (await generateOneImage(options))[0];
      if (!first) throw new Error("No image returned");
      return first;
    } catch (error) {
      if (error.name === "AbortError" || attempt === MAX_IMAGE_ATTEMPTS) throw error;
    }
  }
}

export default function ImageGenerationPage() {
  const router = useRouter();
  const [imageGenEnabled, setImageGenEnabled] = useState(() => isImageGenEnabled());
  const [chatModels, setChatModels] = useState([]);
  const [imageModels, setImageModels] = useState([]);
  const [textModel, setTextModel] = useState("");
  const [imageModel, setImageModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [messages, setMessages] = useState([]);
  const [activeImageByMessage, setActiveImageByMessage] = useState({});
  const [previewImage, setPreviewImage] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState("");
  const [error, setError] = useState("");
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const promptInputRef = useRef(null);

  useEffect(() => subscribeImageGenAccess(setImageGenEnabled), []);

  useEffect(() => {
    if (!imageGenEnabled) router.replace("/dashboard");
  }, [imageGenEnabled, router]);

  useEffect(() => {
    if (!imageGenEnabled) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    async function load() {
      try {
        const [providersRes, disabledRes, keysRes, orderRes] = await Promise.all([
          fetch("/api/providers", { cache: "no-store" }),
          fetch("/api/models/disabled", { cache: "no-store" }),
          fetch("/api/keys", { cache: "no-store" }),
          fetch("/api/models/order", { cache: "no-store" }).catch(() => null),
        ]);
        const providersData = await providersRes.json().catch(() => ({}));
        const disabledData = await disabledRes.json().catch(() => ({}));
        const keysData = await keysRes.json().catch(() => ({}));
        const orderData = orderRes && orderRes.ok ? await orderRes.json().catch(() => ({})) : {};
        if (cancelled) return;
        const connections = providersData.connections || [];
        const disabled = disabledData.disabled || {};
        const modelOrders = orderData.orders || {};
        const nextChatModels = modelOptions(connections, disabled, "llm", modelOrders);
        const nextImageModels = modelOptions(connections, disabled, "image", modelOrders);
        setChatModels(nextChatModels);
        setImageModels(nextImageModels);
        const hasCustomChatOrder = Object.keys(modelOrders).some((k) => k.endsWith(":llm") && modelOrders[k]?.length > 0);
        const hasCustomImageOrder = Object.keys(modelOrders).some((k) => k.endsWith(":image") && modelOrders[k]?.length > 0);
        setTextModel(
          hasCustomChatOrder
            ? (nextChatModels[0]?.id || "")
            : (nextChatModels.find((model) => model.id === "cx/gpt-5.5")?.id || nextChatModels[0]?.id || "")
        );
        setImageModel(
          hasCustomImageOrder
            ? (nextImageModels[0]?.id || "")
            : (nextImageModels.find((model) => model.id === "cx/gpt-5.5-image")?.id || nextImageModels[0]?.id || "")
        );
        setApiKey((keysData.keys || []).find((key) => key.isActive !== false)?.key || "");
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || "Failed to load models");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [imageGenEnabled]);

  useEffect(() => {
    if (!messages.length) return;
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    if (!previewImage) return undefined;
    function closePreview(event) {
      if (event.key === "Escape") setPreviewImage(null);
    }
    window.addEventListener("keydown", closePreview);
    return () => window.removeEventListener("keydown", closePreview);
  }, [previewImage]);

  const selectedTextModel = useMemo(() => chatModels.find((model) => model.id === textModel), [chatModels, textModel]);
  const selectedImageModel = useMemo(() => imageModels.find((model) => model.id === imageModel), [imageModels, imageModel]);

  const updateAssistant = (id, update) => {
    setMessages((current) => current.map((message) => message.id === id ? { ...message, ...update } : message));
  };

  const copyMessage = async (message) => {
    try {
      await navigator.clipboard.writeText(message.content || "");
      setCopiedMessageId(message.id);
      setTimeout(() => setCopiedMessageId((current) => current === message.id ? "" : current), 1500);
    } catch {
      setError("Could not copy message");
    }
  };

  const buildMessages = (nextMessages) => [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    ...nextMessages.slice(-12).map((message) => {
      if (message.role !== "user") return { role: message.role, content: message.content || "" };
      if (!message.references?.length) return { role: "user", content: message.content };
      return {
        role: "user",
        content: [
          { type: "text", text: message.content },
          ...message.references.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      };
    }),
  ];

  const sendMessage = async () => {
    if (!prompt.trim() || !selectedTextModel || !selectedImageModel || sending) return;
    const userMessage = { id: createId("user"), role: "user", content: prompt.trim(), references };
    const assistantId = createId("assistant");
    const nextMessages = [...messages, userMessage];
    setMessages([...nextMessages, { id: assistantId, role: "assistant", content: "", images: [], references: userMessage.references, phase: "thinking" }]);
    setPrompt("");
    if (promptInputRef.current) promptInputRef.current.style.height = "";
    setReferences([]);
    setSending(true);
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: selectedTextModel.id,
          messages: buildMessages(nextMessages),
          tools: IMAGE_AGENT_TOOLS,
          tool_choice: "auto",
          parallel_tool_calls: true,
          stream: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.error?.message || payload?.error || `Chat model failed (HTTP ${response.status})`);
      }

      const { text, toolCalls } = await consumeChatResponse(response, (nextText) => {
        updateAssistant(assistantId, { content: nextText, phase: "thinking" });
      }, controller.signal);
      updateAssistant(assistantId, { content: text, phase: toolCalls.length ? "generating" : "done" });

      const plannedImages = [];
      for (const toolCall of toolCalls) {
        if (toolCall.name !== "generate_image") continue;
        let args = {};
        if (toolCall.arguments && typeof toolCall.arguments === "object") {
          args = toolCall.arguments;
        } else {
          try { args = JSON.parse(toolCall.arguments || "{}"); } catch { args = {}; }
        }
        const imagePrompt = typeof args.prompt === "string" && args.prompt.trim() ? args.prompt.trim() : userMessage.content;
        plannedImages.push({ id: createId("image"), prompt: imagePrompt, status: "generating", attempt: 1, startedAt: Date.now(), elapsedMs: 0 });
      }
      if (!plannedImages.length) {
        updateAssistant(assistantId, { phase: "done" });
        return;
      }
      updateAssistant(assistantId, { phase: "generating", images: plannedImages, generationStartedAt: plannedImages[0].startedAt });

      await Promise.all(plannedImages.map(async (image) => {
        try {
          const first = await generateImageWithRetries(
            { model: selectedImageModel.id, prompt: image.prompt, references: userMessage.references || [], apiKey, signal: controller.signal },
            (attempt) => {
              if (attempt === 1) return;
              setMessages((current) => current.map((message) => message.id === assistantId
                ? { ...message, images: (message.images || []).map((entry) => entry.id === image.id ? { ...entry, attempt } : entry) }
                : message));
            },
          );
          const completedAt = Date.now();
          setMessages((current) => current.map((message) => {
            if (message.id !== assistantId) return message;
            return {
              ...message,
              phase: "generating",
              images: (message.images || []).map((entry) => entry.id === image.id
                ? { ...entry, status: "done", src: imageSrc(first.b64_json || first.url), error: "", completedAt, elapsedMs: completedAt - entry.startedAt }
                : entry),
            };
          }));
        } catch (imageError) {
          const completedAt = Date.now();
          setMessages((current) => current.map((message) => message.id === assistantId
            ? { ...message, images: (message.images || []).map((entry) => entry.id === image.id ? { ...entry, status: "error", error: imageError.message || "Image generation failed", completedAt, elapsedMs: completedAt - entry.startedAt } : entry) }
            : message));
        }
      }));
      updateAssistant(assistantId, { phase: "done", generationCompletedAt: Date.now() });
    } catch (sendError) {
      if (sendError.name === "AbortError") {
        const stoppedAt = Date.now();
        setMessages((current) => current.map((message) => message.id === assistantId
          ? {
              ...message,
              phase: "done",
              generationCompletedAt: stoppedAt,
              images: (message.images || []).map((image) => image.status === "generating"
                ? { ...image, status: "error", error: "Generation stopped" }
                : image),
            }
          : message));
      } else {
        setError(sendError.message || "Request failed");
        updateAssistant(assistantId, { phase: "error", content: sendError.message || "Request failed" });
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  };

  const retryImage = async (messageId, imageId) => {
    if (!selectedImageModel) return;
    const messageIndex = messages.findIndex((message) => message.id === messageId);
    const message = messages[messageIndex];
    const image = message?.images?.find((entry) => entry.id === imageId);
    if (!message || !image || image.status === "generating") return;
    const referencesForRetry = message.references || messages[messageIndex - 1]?.references || [];
    const startedAt = Date.now();
    setMessages((current) => current.map((entry) => entry.id === messageId
      ? { ...entry, phase: "generating", generationStartedAt: startedAt, generationCompletedAt: undefined, images: (entry.images || []).map((item) => item.id === imageId ? { ...item, status: "generating", attempt: 1, startedAt, elapsedMs: 0, error: "" } : item) }
      : entry));
    try {
      const first = await generateImageWithRetries(
        { model: selectedImageModel.id, prompt: image.prompt, references: referencesForRetry, apiKey },
        (attempt) => {
          if (attempt === 1) return;
          setMessages((current) => current.map((entry) => entry.id === messageId
            ? { ...entry, images: (entry.images || []).map((item) => item.id === imageId ? { ...item, attempt } : item) }
            : entry));
        },
      );
      const completedAt = Date.now();
      setMessages((current) => current.map((entry) => {
        if (entry.id !== messageId) return entry;
        const images = (entry.images || []).map((item) => item.id === imageId
          ? { ...item, status: "done", src: imageSrc(first.b64_json || first.url), error: "", completedAt, elapsedMs: completedAt - startedAt }
          : item);
        return { ...entry, phase: images.some((item) => item.status === "generating") ? "generating" : "done", images, generationCompletedAt: images.some((item) => item.status === "generating") ? undefined : completedAt };
      }));
    } catch (imageError) {
      const completedAt = Date.now();
      setMessages((current) => current.map((entry) => {
        if (entry.id !== messageId) return entry;
        const images = (entry.images || []).map((item) => item.id === imageId ? { ...item, status: "error", error: imageError.message || "Image generation failed", completedAt, elapsedMs: completedAt - startedAt } : item);
        return { ...entry, phase: images.some((item) => item.status === "generating") ? "generating" : "done", images, generationCompletedAt: images.some((item) => item.status === "generating") ? undefined : completedAt };
      }));
    }
  };

  const addReferenceFiles = async (files) => {
    const imageFiles = files.filter((file) => file?.type?.startsWith("image/"));
    try {
      const next = await Promise.all(imageFiles.slice(0, 4).map(async (file) => ({ name: file.name, dataUrl: await fileToDataUrl(file) })));
      setReferences((current) => [...current, ...next.map((file) => file.dataUrl)]);
    } catch (fileError) {
      setError(fileError.message || "Failed to read image");
    }
  };

  const handleFiles = async (event) => {
    await addReferenceFiles(Array.from(event.target.files || []));
    event.target.value = "";
  };

  const handlePaste = async (event) => {
    const files = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length === 0) return;
    event.preventDefault();
    await addReferenceFiles(files);
  };

  const resetChat = () => {
    if (sending) abortRef.current?.abort();
    setMessages([]);
    setActiveImageByMessage({});
    setPreviewImage(null);
    setPrompt("");
    if (promptInputRef.current) promptInputRef.current.style.height = "";
    setReferences([]);
    setError("");
  };

  if (!imageGenEnabled) {
    return <div className="flex h-full items-center justify-center text-sm text-text-muted"></div>;
  }

  return (
    <div className="flex min-h-full flex-col gap-3">
      <div className="sticky top-14 z-20 -mx-2 flex flex-wrap items-end justify-between gap-3 bg-transparent px-2 pb-3 pt-1 sm:-mx-4 sm:px-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Image Studio</h1>
          <p className="mt-1 text-sm text-text-muted">Chat first. The text model plans, then image generation starts immediately.</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">Text</span>
          <select value={textModel} onChange={(event) => setTextModel(event.target.value)} disabled={loading || !chatModels.length} className="h-9 w-[min(220px,30vw)] min-w-37.5 rounded-lg border border-border/80 bg-transparent px-2.5 text-xs focus:border-primary focus:outline-none">
            {chatModels.map((model) => <option key={model.id} value={model.id}>{model.name} ({model.alias})</option>)}
          </select>
          <span className="ml-1 text-xs font-semibold uppercase tracking-wider text-text-muted">Image</span>
          <select value={imageModel} onChange={(event) => setImageModel(event.target.value)} disabled={loading || !imageModels.length} className="h-9 w-[min(220px,30vw)] min-w-37.5 rounded-lg border border-border/80 bg-transparent px-2.5 text-xs focus:border-primary focus:outline-none">
            {imageModels.map((model) => <option key={model.id} value={model.id}>{model.name} ({model.alias})</option>)}
          </select>
          <Button variant="secondary" size="md" icon="add_comment" onClick={resetChat}>New chat</Button>
        </div>
      </div>

      <div className="flex flex-1 flex-col">

        <div ref={scrollRef} className={`flex flex-1 flex-col gap-5 bg-transparent px-4 pt-5 sm:px-8 ${messages.length > 0 ? references.length > 0 ? "pb-64" : "pb-40" : "pb-5"}`}>
          {messages.length === 0 && (
            <div className="m-auto max-w-lg text-center">
              <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><span className="material-symbols-outlined text-[30px]">auto_awesome</span></div>
              <h2 className="text-xl font-semibold">What image should we make?</h2>
              <p className="mt-2 text-sm text-text-muted">Ask a question normally, or describe an image. The assistant decides when to call the image model.</p>
            </div>
          )}
          {messages.map((message) => (
            <div key={message.id} className={`flex items-start gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}>
              {message.role === "assistant" && <div className={`${message.phase === "thinking" && !message.content ? "" : "mt-1"} flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary`}><span className="material-symbols-outlined text-[18px]">auto_awesome</span></div>}
              <div className={`max-w-[min(840px,90%)] ${message.role === "user" ? "rounded-2xl rounded-br-md bg-primary px-4 py-3 text-white shadow-sm" : "min-w-0"}`}>
                {message.content && (
                  <div className={`text-sm leading-7 ${
                    message.role === "assistant"
                      ? "font-medium text-text-main [text-shadow:_0_1px_2px_var(--color-bg),_0_0_8px_var(--color-bg)]"
                      : ""
                  }`}>
                    <MarkdownText content={message.content} />
                  </div>
                )}
                {message.role === "assistant" && message.phase === "thinking" && !message.content && <p className="flex h-8 items-center text-sm text-text-muted">Thinking<span className="animate-pulse">...</span></p>}
                {message.role === "assistant" && message.phase === "generating" && (() => {
                  const total = message.images?.length || 0;
                  const completed = message.images?.filter((image) => image.status === "done").length || 0;
                  const failed = message.images?.filter((image) => image.status === "error").length || 0;
                  return <div className="mt-3 rounded-xl border border-border-subtle bg-surface-2/60 px-3 py-2 text-xs text-text-muted">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-text-main">Generating {total} image{total === 1 ? "" : "s"}</span>
                      <span>{completed}/{total} ready{failed ? ` - ${failed} failed` : ""}</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border-subtle"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${total ? (completed / total) * 100 : 0}%` }} /></div>
                  </div>;
                })()}
                {message.references?.length > 0 && <div className="mt-2 flex gap-2">{message.references.map((url, index) => <button key={`${url}-${index}`} type="button" onClick={() => setPreviewImage({ src: url, prompt: message.content })} className="cursor-zoom-in rounded-lg" aria-label={`Open reference image ${index + 1}`}><img src={url} alt={`Reference ${index + 1}`} className="size-16 rounded-lg object-cover" /></button>)}</div>}
                {message.images?.length > 0 && (() => {
                  const activeIndex = Math.min(activeImageByMessage[message.id] || 0, message.images.length - 1);
                  const activeImage = message.images[activeIndex];
                  const activeElapsed = activeImage.elapsedMs || 0;
                  const readyImages = message.images.filter((image) => image.status === "done" && image.src);
                  return <div className="mt-3 flex max-w-100 gap-2 rounded-xl border border-border bg-background p-2">
                    <div className="relative min-w-0 flex-1 overflow-hidden rounded-lg bg-surface-2">
                      {activeImage.status === "done" && activeImage.src ? <button type="button" onClick={() => setPreviewImage(activeImage)} className="block w-full cursor-zoom-in" aria-label="Open image preview"><img src={activeImage.src} alt={`Generated image ${activeIndex + 1}`} className="aspect-square w-full object-contain" /></button> : activeImage.status === "error" ? <div className="flex aspect-square flex-col items-center justify-center gap-3 p-4 text-center text-xs text-red-500"><span>{activeImage.error}</span><button type="button" onClick={() => retryImage(message.id, activeImage.id)} className="inline-flex items-center gap-1 rounded-md bg-red-500 px-2.5 py-1.5 font-medium text-white hover:bg-red-600"><span className="material-symbols-outlined text-[15px]">refresh</span>Retry</button><span className="text-[11px] text-text-muted">Automatic retry exhausted{activeElapsed ? ` - ${formatDuration(activeElapsed)}` : ""}</span></div> : <ImageGeneratingPlaceholder label={`Generating image ${activeIndex + 1}`} attempt={activeImage.attempt} />}
                      <div className="absolute left-2 top-2 flex items-center gap-1"><span className="rounded-md bg-black/60 px-2 py-1 text-[11px] font-medium text-white">{activeIndex + 1}/{message.images.length}</span><button type="button" title={activeImage.prompt} aria-label="Show image prompt" className="flex size-6 items-center justify-center rounded-md bg-black/60 text-white hover:bg-black/75"><span className="material-symbols-outlined text-[15px]">info</span></button></div>
                      {readyImages.length > 1 && <button type="button" onClick={() => downloadImages(readyImages)} className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-[11px] font-medium text-white hover:bg-black/75"><span className="material-symbols-outlined text-[15px]">download</span>Download all</button>}
                      <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-2"><span className="rounded-md bg-black/60 px-2 py-1 text-[11px] text-white">{activeImage.status === "done" ? `Ready - ${formatDuration(activeElapsed)}` : activeImage.status === "error" ? "Failed" : "Generating..."}</span>{activeImage.status === "done" && activeImage.src && <a href={activeImage.src} download={`9router-image-${activeIndex + 1}.png`} className="inline-flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-[11px] font-medium text-white hover:bg-black/75"><span className="material-symbols-outlined text-[15px]">download</span>Download</a>}</div>
                    </div>
                    {message.images.length > 1 && <div className="custom-scrollbar grid h-72 w-16 shrink-0 grid-cols-1 content-start gap-2 overflow-y-auto pr-1">
                      {message.images.map((image, index) => <button key={image.id} type="button" title={image.prompt} onClick={() => setActiveImageByMessage((current) => ({ ...current, [message.id]: index }))} className={`relative overflow-hidden rounded-lg border-2 bg-surface-2 ${activeIndex === index ? "border-primary" : "border-transparent hover:border-border"}`} aria-label={`Show image ${index + 1}`}><div className="flex aspect-square items-center justify-center">{image.status === "done" && image.src ? <img src={image.src} alt="" className="h-full w-full object-cover" /> : image.status === "error" ? <span className="material-symbols-outlined text-[18px] text-red-500">error</span> : <span className="size-2 animate-pulse rounded-full bg-text-muted" />}</div><span className="absolute bottom-1 left-1 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white">{index + 1}</span></button>)}
                    </div>}
                  </div>;
                })()}
                {message.role === "assistant" && message.content && <div className="mt-2 flex items-center gap-3 text-xs text-text-muted">
                  {message.phase === "done" && message.images?.length > 0 && <span>{message.images.filter((image) => image.status === "done").length}/{message.images.length} images ready - total {formatDuration((message.generationCompletedAt || 0) - (message.generationStartedAt || 0))}</span>}
                  <button type="button" onClick={() => copyMessage(message)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-surface-2 hover:text-text-main" title="Copy message"><span className="material-symbols-outlined text-[15px]">{copiedMessageId === message.id ? "check" : "content_copy"}</span>{copiedMessageId === message.id ? "Copied" : "Copy"}</button>
                </div>}
              </div>
              {message.role === "user" && <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-text-muted"><span className="material-symbols-outlined text-[18px]">person</span></div>}
            </div>
          ))}
        </div>

        <div className="sticky bottom-0 z-20 shrink-0 bg-transparent px-2 py-3 sm:px-4">
          {error && <p className="pb-2 text-sm text-red-500">{error}</p>}
          {references.length > 0 && <div className="mb-2 flex gap-2 overflow-x-auto">{references.map((url, index) => <div key={`${url}-${index}`} className="relative shrink-0 pb-1 pr-2 pt-2"><button type="button" onClick={() => setPreviewImage({ src: url, prompt: "Reference image" })} className="cursor-zoom-in rounded-lg" aria-label={`Preview reference image ${index + 1}`}><img src={url} alt={`Reference ${index + 1}`} className="size-20 rounded-lg object-cover" /></button><button type="button" aria-label="Remove reference image" onClick={() => setReferences((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="absolute right-0 top-0 flex size-5 items-center justify-center rounded-full bg-black/75 text-xs text-white">x</button></div>)}</div>}
          <div className="flex items-end gap-2 rounded-2xl border border-border/80 bg-transparent p-2 focus-within:border-primary shadow-xs">
            <label className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-text-muted hover:bg-surface-2/60 hover:text-primary"><span className="material-symbols-outlined text-[20px]">attach_file</span><input type="file" accept="image/*" multiple onChange={handleFiles} className="hidden" /></label>
            <textarea ref={promptInputRef} value={prompt} onChange={(event) => { const element = event.currentTarget; element.style.height = "auto"; element.style.height = `${Math.min(element.scrollHeight, 112)}px`; setPrompt(element.value); }} onPaste={handlePaste} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} rows={1} placeholder="Message Image Studio... Paste an image with Ctrl+V" className="max-h-28 min-h-9 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-2 text-sm leading-6 outline-none" />
            {sending ? <Button variant="secondary" size="md" icon="stop" onClick={() => abortRef.current?.abort()}>Stop</Button> : <Button size="md" icon="arrow_upward" onClick={sendMessage} disabled={loading || !prompt.trim() || !selectedTextModel || !selectedImageModel}>Send</Button>}
          </div>
        </div>
      </div>
      {previewImage?.src && <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label="Image preview" onClick={() => setPreviewImage(null)}>
        <div className="relative max-h-full max-w-full" onClick={(event) => event.stopPropagation()}>
          <img src={previewImage.src} alt="Large preview" className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain shadow-2xl" />
          <div className="absolute right-2 top-2 flex gap-2">
            <a href={previewImage.src} download="9router-image-preview.png" className="flex size-9 items-center justify-center rounded-full bg-black/65 text-white hover:bg-black/85" aria-label="Download preview"><span className="material-symbols-outlined text-[18px]">download</span></a>
            <button type="button" onClick={() => setPreviewImage(null)} className="flex size-9 items-center justify-center rounded-full bg-black/65 text-white hover:bg-black/85" aria-label="Close preview"><span className="material-symbols-outlined text-[20px]">close</span></button>
          </div>
        </div>
      </div>}
    </div>
  );
}
