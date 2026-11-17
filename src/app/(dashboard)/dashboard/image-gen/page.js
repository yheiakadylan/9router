"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/shared/components";
import { getModelKind, getModelsByProviderId } from "@/shared/constants/models";
import { getProviderAlias, getProvidersByKind } from "@/shared/constants/providers";
import { isImageGenEnabled, subscribeImageGenAccess } from "@/shared/utils/imageGenAccess";

const MAX_IMAGE_RETRIES = 3;
const MESSAGE_PAGE_SIZE = 5;

function createId(prefix) {
  return globalThis.crypto?.randomUUID?.() || `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function imageSrc(value) {
  if (!value) return "";
  if (/^(data:image\/|https?:\/\/|blob:|\/api\/image-studio\/assets\/)/i.test(value)) return value;
  return `data:image/png;base64,${value}`;
}

function expiryLabel(expiresAt, now) {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return "Kept up to 24h";
  const minutes = Math.max(0, Math.ceil((expiry - now) / 60_000));
  if (minutes < 60) return `Deletes in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `Deletes in ${hours}h${remainder ? ` ${remainder}m` : ""}`;
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
        <blockquote key={elements.length} className="my-1.5 rounded-md border border-border/70 bg-surface-2/40 px-3 py-1.5 italic text-text-muted">
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

function ConversationStatus({ status }) {
  if (status === "generating") return <span className="flex size-5 items-center justify-center" title="Generating"><span className="material-symbols-outlined animate-spin text-[17px] text-primary">progress_activity</span></span>;
  if (status === "success") return <span className="material-symbols-outlined text-[18px] text-green-500" title="Completed">check_circle</span>;
  if (status === "error") return <span className="material-symbols-outlined text-[18px] text-red-500" title="Failed">error</span>;
  return <span className="material-symbols-outlined text-[17px] text-text-muted" title="Ready">chat_bubble</span>;
}

export default function ImageGenerationPage() {
  const router = useRouter();
  const [imageGenEnabled, setImageGenEnabled] = useState(() => isImageGenEnabled());
  const [chatModels, setChatModels] = useState([]);
  const [imageModels, setImageModels] = useState([]);
  const [textModel, setTextModel] = useState("");
  const [imageModel, setImageModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [conversations, setConversations] = useState([]);
  const [activeJobs, setActiveJobs] = useState({});
  const [conversationId, setConversationId] = useState("");
  const [activeImageByMessage, setActiveImageByMessage] = useState({});
  const [previewImage, setPreviewImage] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copiedMessageId, setCopiedMessageId] = useState("");
  const [error, setError] = useState("");
  const [visibleMessageCount, setVisibleMessageCount] = useState(MESSAGE_PAGE_SIZE);
  const [expiryNow, setExpiryNow] = useState(() => Date.now());
  const conversationsRef = useRef([]);
  const saveQueuesRef = useRef(new Map());
  const scrollRef = useRef(null);
  const promptInputRef = useRef(null);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === conversationId) || null,
    [conversations, conversationId]
  );
  const messages = useMemo(() => activeConversation?.messages || [], [activeConversation]);
  const visibleMessages = useMemo(() => messages.slice(-visibleMessageCount), [messages, visibleMessageCount]);
  const hiddenMessageCount = Math.max(0, messages.length - visibleMessages.length);
  const sending = Boolean(activeJobs[conversationId]);
  const hasGeneratingConversations = conversations.some((conversation) => conversation.status === "generating");
  const selectedTextModel = useMemo(() => chatModels.find((model) => model.id === textModel), [chatModels, textModel]);
  const selectedImageModel = useMemo(() => imageModels.find((model) => model.id === imageModel), [imageModels, imageModel]);

  function replaceConversations(updater) {
    const next = typeof updater === "function" ? updater(conversationsRef.current) : updater;
    conversationsRef.current = next;
    setConversations(next);
    return next;
  }

  function patchConversation(id, updater) {
    let patched = null;
    replaceConversations((current) => current.map((conversation) => {
      if (conversation.id !== id) return conversation;
      patched = typeof updater === "function" ? updater(conversation) : { ...conversation, ...updater };
      return patched;
    }));
    return patched;
  }

  async function persistConversation(conversation) {
    if (!conversation) return;
    const payload = {
      title: conversation.title,
      status: conversation.status,
      textModel: conversation.textModel,
      imageModel: conversation.imageModel,
      messages: conversation.messages || [],
    };
    const previous = saveQueuesRef.current.get(conversation.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => fetch(`/api/image-studio/conversations/${encodeURIComponent(conversation.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })).catch(() => {});
    saveQueuesRef.current.set(conversation.id, next);
    await next;
  }

  function patchMessages(id, updater) {
    return patchConversation(id, (conversation) => ({
      ...conversation,
      messages: updater(conversation.messages || []),
    }));
  }

  const applyConversationPayload = useCallback((payload) => {
    const next = payload.conversations || [];
    conversationsRef.current = next;
    setConversations(next);
    setActiveJobs(Object.fromEntries((payload.jobs || []).map((job) => [job.conversationId, job.id])));
  }, []);

  useEffect(() => subscribeImageGenAccess(setImageGenEnabled), []);

  useEffect(function updateExpiryLabels() {
    const timer = setInterval(() => setExpiryNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!imageGenEnabled) router.replace("/dashboard");
  }, [imageGenEnabled, router]);

  useEffect(() => {
    if (!imageGenEnabled) {
      return undefined;
    }
    let cancelled = false;
    async function load() {
      try {
        const [providersRes, disabledRes, keysRes, orderRes, conversationsRes] = await Promise.all([
          fetch("/api/providers", { cache: "no-store" }),
          fetch("/api/models/disabled", { cache: "no-store" }),
          fetch("/api/keys", { cache: "no-store" }),
          fetch("/api/models/order", { cache: "no-store" }).catch(() => null),
          fetch("/api/image-studio/conversations", { cache: "no-store" }),
        ]);
        const providersData = await providersRes.json().catch(() => ({}));
        const disabledData = await disabledRes.json().catch(() => ({}));
        const keysData = await keysRes.json().catch(() => ({}));
        const orderData = orderRes && orderRes.ok ? await orderRes.json().catch(() => ({})) : {};
        const conversationData = await conversationsRes.json().catch(() => ({}));
        if (cancelled) return;
        const connections = providersData.connections || [];
        const disabled = disabledData.disabled || {};
        const modelOrders = orderData.orders || {};
        const nextChatModels = modelOptions(connections, disabled, "llm", modelOrders);
        const nextImageModels = modelOptions(connections, disabled, "image", modelOrders);
        const hasCustomChatOrder = Object.keys(modelOrders).some((key) => key.endsWith(":llm") && modelOrders[key]?.length > 0);
        const hasCustomImageOrder = Object.keys(modelOrders).some((key) => key.endsWith(":image") && modelOrders[key]?.length > 0);
        const defaultTextModel = hasCustomChatOrder
          ? nextChatModels[0]?.id || ""
          : nextChatModels.find((model) => model.id === "cx/gpt-6-sol" || model.id === "cx/gpt-5.5")?.id || nextChatModels[0]?.id || "";
        const defaultImageModel = hasCustomImageOrder
          ? nextImageModels[0]?.id || ""
          : nextImageModels.find((model) => model.id === "cx/gpt-6-sol-image" || model.id === "cx/gpt-image-2.5" || model.id === "cx/gpt-5.5-image")?.id || nextImageModels[0]?.id || "";
        setChatModels(nextChatModels);
        setImageModels(nextImageModels);
        setApiKey((keysData.keys || []).find((key) => key.isActive !== false)?.key || "");

        let saved = conversationData.conversations || [];
        if (saved.length === 0) {
          const createResponse = await fetch("/api/image-studio/conversations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ textModel: defaultTextModel, imageModel: defaultImageModel }),
          });
          const created = await createResponse.json().catch(() => ({}));
          saved = created.conversation ? [created.conversation] : [];
        }
        applyConversationPayload({ ...conversationData, conversations: saved });
        const first = saved[0];
        if (first) {
          setConversationId(first.id);
          setTextModel(first.textModel || defaultTextModel);
          setImageModel(first.imageModel || defaultImageModel);
        } else {
          setTextModel(defaultTextModel);
          setImageModel(defaultImageModel);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || "Failed to load Image Studio");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [applyConversationPayload, imageGenEnabled]);

  useEffect(() => {
    if (!hasGeneratingConversations) return undefined;
    let cancelled = false;
    async function refreshGeneratingConversations() {
      try {
        const response = await fetch("/api/image-studio/conversations", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!cancelled && response.ok) applyConversationPayload(payload);
      } catch {}
    }
    const timer = setInterval(refreshGeneratingConversations, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [applyConversationPayload, hasGeneratingConversations]);

  useEffect(() => {
    if (messages.length > 0) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  useEffect(() => {
    if (!previewImage) return undefined;
    function closePreview(event) {
      if (event.key === "Escape") setPreviewImage(null);
    }
    window.addEventListener("keydown", closePreview);
    return () => window.removeEventListener("keydown", closePreview);
  }, [previewImage]);

  async function createConversation() {
    try {
      const response = await fetch("/api/image-studio/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ textModel, imageModel }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Failed to create chat");
      replaceConversations((current) => [payload.conversation, ...current].slice(0, 20));
      setConversationId(payload.conversation.id);
      setVisibleMessageCount(MESSAGE_PAGE_SIZE);
      setPrompt("");
      setReferences([]);
      setError("");
    } catch (createError) {
      setError(createError.message || "Failed to create chat");
    }
  }

  function selectConversation(conversation) {
    setConversationId(conversation.id);
    setVisibleMessageCount(MESSAGE_PAGE_SIZE);
    setTextModel(conversation.textModel || textModel);
    setImageModel(conversation.imageModel || imageModel);
    setPrompt("");
    setReferences([]);
    setError("");
  }

  async function removeConversation(event, id) {
    event.stopPropagation();
    const jobId = activeJobs[id];
    if (jobId) await fetch(`/api/image-studio/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
    await fetch(`/api/image-studio/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    const remaining = conversationsRef.current.filter((conversation) => conversation.id !== id);
    replaceConversations(remaining);
    if (conversationId === id) {
      if (remaining[0]) selectConversation(remaining[0]);
      else await createConversation();
    }
  }

  const copyMessage = async (message) => {
    try {
      await navigator.clipboard.writeText(message.content || "");
      setCopiedMessageId(message.id);
      setTimeout(() => setCopiedMessageId((current) => current === message.id ? "" : current), 1500);
    } catch {
      setError("Could not copy message");
    }
  };

  async function sendMessage() {
    if (!conversationId || !prompt.trim() || !selectedTextModel || !selectedImageModel || activeJobs[conversationId]) return;
    const currentId = conversationId;
    const previousConversation = activeConversation;
    const userMessage = { id: createId("user"), role: "user", content: prompt.trim(), references };
    const assistantId = createId("assistant");
    const nextMessages = [...messages, userMessage];
    const title = messages.length === 0 ? userMessage.content.slice(0, 64) : activeConversation.title;
    const conversation = patchConversation(currentId, (current) => ({
      ...current,
      title,
      status: "generating",
      textModel: selectedTextModel.id,
      imageModel: selectedImageModel.id,
      messages: [...nextMessages, { id: assistantId, role: "assistant", content: "", images: [], phase: "thinking" }],
    }));
    setPrompt("");
    setReferences([]);
    setError("");
    if (promptInputRef.current) promptInputRef.current.style.height = "";
    try {
      const response = await fetch("/api/image-studio/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: currentId,
          assistantId,
          title,
          textModel: selectedTextModel.id,
          imageModel: selectedImageModel.id,
          apiKey,
          messages: conversation.messages,
          userPrompt: userMessage.content,
          userReferences: userMessage.references,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Failed to start job (HTTP ${response.status})`);
      }
      setActiveJobs((current) => ({ ...current, [currentId]: payload.jobId }));
    } catch (sendError) {
      patchConversation(currentId, previousConversation);
      setPrompt(userMessage.content);
      setReferences(userMessage.references);
      setError(sendError.message || "Failed to start job");
    }
  }

  async function retryImage(messageId, imageId) {
    if (!selectedImageModel || !conversationId || activeJobs[conversationId]) return;
    const currentId = conversationId;
    try {
      const response = await fetch("/api/image-studio/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: currentId,
          assistantId: messageId,
          title: activeConversation.title,
          textModel: selectedTextModel?.id || activeConversation.textModel,
          imageModel: selectedImageModel.id,
          apiKey,
          messages,
          retry: { messageId, imageId },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to retry image");
      patchConversation(currentId, { status: "generating" });
      setActiveJobs((current) => ({ ...current, [currentId]: payload.jobId }));
    } catch (retryError) {
      setError(retryError.message || "Failed to retry image");
    }
  }

  async function stopJob() {
    const jobId = activeJobs[conversationId];
    if (!jobId) return;
    await fetch(`/api/image-studio/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
  }

  async function uploadAsset(file) {
    const form = new FormData();
    form.append("conversationId", conversationId);
    form.append("file", file);
    const response = await fetch("/api/image-studio/assets", { method: "POST", body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Failed to save image");
    return payload.asset.url;
  }

  async function addReferenceFiles(files) {
    const imageFiles = files.filter((file) => file?.type?.startsWith("image/")).slice(0, 4);
    try {
      const urls = await Promise.all(imageFiles.map(uploadAsset));
      setReferences((current) => [...new Set([...current, ...urls])].slice(0, 4));
    } catch (fileError) {
      setError(fileError.message || "Failed to save image");
    }
  }

  async function handleFiles(event) {
    await addReferenceFiles(Array.from(event.target.files || []));
    event.target.value = "";
  }

  async function handlePaste(event) {
    const files = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length === 0) return;
    event.preventDefault();
    await addReferenceFiles(files);
  }

  async function handleDrop(event) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length > 0) {
      await addReferenceFiles(files);
      return;
    }
    const src = event.dataTransfer?.getData("application/x-9router-image")
      || event.dataTransfer?.getData("text/uri-list")
      || event.dataTransfer?.getData("text/plain");
    if (/^\/api\/image-studio\/assets\//.test(src || "")) addImageToChat(src);
  }

  function handleImageDragStart(event, src) {
    if (!src) return;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-9router-image", src);
    event.dataTransfer.setData("text/uri-list", src);
  }

  function addImageToChat(src) {
    if (!src) return;
    setReferences((current) => [...new Set([...current, src])].slice(0, 4));
    promptInputRef.current?.focus();
  }

  function changeTextModel(value) {
    setTextModel(value);
    persistConversation(patchConversation(conversationId, { textModel: value }));
  }

  function changeImageModel(value) {
    setImageModel(value);
    persistConversation(patchConversation(conversationId, { imageModel: value }));
  }

  if (!imageGenEnabled) return <div className="flex h-full items-center justify-center text-sm text-text-muted" />;

  const conversationButtons = conversations.map((conversation) => (
    <div key={conversation.id} className={`group flex min-w-48 items-center rounded-xl transition-colors ${conversation.id === conversationId ? "bg-primary/10 text-text-main" : "text-text-muted hover:bg-surface-2 hover:text-text-main"}`}>
      <button type="button" onClick={() => selectConversation(conversation)} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left">
        <ConversationStatus status={conversation.status} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{conversation.title || "New image chat"}</span>
          <time dateTime={conversation.expiresAt} title={new Date(conversation.expiresAt).toLocaleString()} className="mt-0.5 block text-[10px] text-text-muted">{expiryLabel(conversation.expiresAt, expiryNow)}</time>
        </span>
      </button>
      <button type="button" onClick={(event) => removeConversation(event, conversation.id)} className="mr-2 hidden size-7 items-center justify-center rounded-md opacity-60 hover:bg-red-500/10 hover:text-red-500 group-hover:flex focus:flex" aria-label="Delete conversation"><span className="material-symbols-outlined text-[16px]">delete</span></button>
    </div>
  ));

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-hidden">
      <aside className="hidden min-h-0 w-60 shrink-0 flex-col rounded-2xl bg-surface-2/55 p-2 lg:flex">
        <div className="flex items-center justify-between px-2 py-2">
          <div><p className="text-sm font-semibold text-text-main">Conversations</p><p className="text-[11px] text-text-muted">20 chats - kept 24 hours</p></div>
          <button type="button" onClick={createConversation} className="flex size-8 items-center justify-center rounded-lg text-text-muted hover:bg-surface-3 hover:text-primary" aria-label="New conversation"><span className="material-symbols-outlined text-[19px]">add_comment</span></button>
        </div>
        <div className="custom-scrollbar mt-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">{conversationButtons}</div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="mb-2 flex shrink-0 gap-2 overflow-x-auto pb-1 lg:hidden">{conversationButtons}</div>
        <div className="z-20 flex shrink-0 flex-wrap items-end justify-between gap-3 bg-background/95 pb-3 pt-1 backdrop-blur-sm">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Image Studio</h1>
            <p className="mt-1 text-sm text-text-muted">Chats and images are saved locally for 24 hours.</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">Text</span>
            <select value={textModel} onChange={(event) => changeTextModel(event.target.value)} disabled={loading || !chatModels.length} className="h-9 w-[min(220px,30vw)] min-w-37.5 rounded-lg border border-border/80 bg-transparent px-2.5 text-xs focus:border-primary focus:outline-none">
              {chatModels.map((model) => <option key={model.id} value={model.id}>{model.name} ({model.alias})</option>)}
            </select>
            <span className="ml-1 text-xs font-semibold uppercase tracking-wider text-text-muted">Image</span>
            <select value={imageModel} onChange={(event) => changeImageModel(event.target.value)} disabled={loading || !imageModels.length} className="h-9 w-[min(220px,30vw)] min-w-37.5 rounded-lg border border-border/80 bg-transparent px-2.5 text-xs focus:border-primary focus:outline-none">
              {imageModels.map((model) => <option key={model.id} value={model.id}>{model.name} ({model.alias})</option>)}
            </select>
            <Button variant="secondary" size="md" icon="add_comment" onClick={createConversation}>New chat</Button>
          </div>
        </div>

        <div ref={scrollRef} className="custom-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto bg-transparent px-2 pb-5 pt-5 sm:px-6">
          {messages.length === 0 ? <div className="m-auto max-w-lg text-center"><div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><span className="material-symbols-outlined text-[30px]">auto_awesome</span></div><h2 className="text-xl font-semibold">What image should we make?</h2><p className="mt-2 text-sm text-text-muted">Generate here, then use “Add to chat” to reuse any result without copying base64.</p></div> : null}
          {hiddenMessageCount > 0 ? <button type="button" onClick={() => setVisibleMessageCount((count) => count + MESSAGE_PAGE_SIZE)} className="mx-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/80 bg-surface-2 px-3 py-2 text-xs font-medium text-text-muted hover:border-primary/40 hover:text-text-main"><span className="material-symbols-outlined text-[16px]">history</span>Show {Math.min(MESSAGE_PAGE_SIZE, hiddenMessageCount)} older · {hiddenMessageCount} hidden</button> : null}
          {visibleMessages.map((message) => (
            <div key={message.id} className={`flex items-start gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}>
              {message.role === "assistant" ? <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><span className="material-symbols-outlined text-[18px]">auto_awesome</span></div> : null}
              <div className={`max-w-[min(840px,92%)] ${message.role === "user" ? "rounded-2xl rounded-br-md bg-primary px-4 py-3 text-white shadow-sm" : "min-w-0"}`}>
                {message.content ? <div className={`text-sm leading-7 ${message.role === "assistant" ? "font-medium text-text-main" : ""}`}><MarkdownText content={message.content} /></div> : null}
                {message.role === "assistant" && message.phase === "thinking" && !message.content ? <p className="flex h-8 items-center text-sm text-text-muted">Thinking<span className="animate-pulse">...</span></p> : null}
                {message.role === "user" && message.references?.length > 0 ? <div className="mt-2 flex gap-2">{message.references.map((url, index) => <button key={`${url}-${index}`} type="button" onClick={() => setPreviewImage({ src: url })} className="cursor-zoom-in rounded-lg"><img src={url} alt={`Reference ${index + 1}`} className="size-16 rounded-lg object-cover" /></button>)}</div> : null}
                {message.images?.length > 0 ? (() => {
                  const activeIndex = Math.min(activeImageByMessage[message.id] || 0, message.images.length - 1);
                  const activeImage = message.images[activeIndex];
                  const readyImages = message.images.filter((image) => image.status === "done" && image.src);
                  return <div className="mt-3 flex max-w-105 gap-2 rounded-xl bg-surface-2/55 p-2">
                    <div className="relative min-w-0 flex-1 overflow-hidden rounded-lg bg-surface-2">
                      {activeImage.status === "done" && activeImage.src ? <button type="button" onClick={() => setPreviewImage(activeImage)} className="block w-full cursor-zoom-in"><img src={activeImage.src} alt={`Generated image ${activeIndex + 1}`} draggable onDragStart={(event) => handleImageDragStart(event, activeImage.src)} className="aspect-square w-full object-contain" /></button> : activeImage.status === "error" ? <div className="flex aspect-square flex-col items-center justify-center gap-3 p-4 text-center text-xs text-red-500"><span>{activeImage.error}</span><button type="button" onClick={() => retryImage(message.id, activeImage.id)} className="inline-flex items-center gap-1 rounded-md bg-red-500 px-2.5 py-1.5 font-medium text-white"><span className="material-symbols-outlined text-[15px]">refresh</span>Retry</button></div> : <ImageGeneratingPlaceholder label={`Generating image ${activeIndex + 1}`} attempt={activeImage.attempt} />}
                      <div className="absolute left-2 top-2 flex items-center gap-1"><span className="rounded-md bg-black/65 px-2 py-1 text-[11px] text-white">{activeIndex + 1}/{message.images.length}</span><span title={activeImage.prompt} className="flex size-6 items-center justify-center rounded-md bg-black/65 text-white"><span className="material-symbols-outlined text-[15px]">info</span></span></div>
                      {activeImage.status === "done" && activeImage.src ? <button type="button" onClick={() => addImageToChat(activeImage.src)} className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-md hover:bg-brand-600"><span className="material-symbols-outlined text-[16px]">add_photo_alternate</span>Add to chat</button> : null}
                      <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-2"><span className="rounded-md bg-black/65 px-2 py-1 text-[11px] text-white">{activeImage.status === "done" ? `Ready - ${formatDuration(activeImage.elapsedMs)}` : activeImage.status === "error" ? "Failed" : "Generating..."}</span>{activeImage.src ? <a href={activeImage.src} download={`9router-image-${activeIndex + 1}.png`} className="inline-flex items-center gap-1 rounded-md bg-black/65 px-2 py-1 text-[11px] font-medium text-white"><span className="material-symbols-outlined text-[15px]">download</span>Download</a> : null}</div>
                    </div>
                    {message.images.length > 1 ? <div className="custom-scrollbar grid h-72 w-16 shrink-0 content-start gap-2 overflow-y-auto pr-1">{message.images.map((image, index) => <button key={image.id} type="button" onClick={() => setActiveImageByMessage((current) => ({ ...current, [message.id]: index }))} className={`relative overflow-hidden rounded-lg border-2 bg-surface-2 ${activeIndex === index ? "border-primary" : "border-transparent"}`}>{image.src ? <img src={image.src} alt="" className="aspect-square w-full object-cover" /> : <span className="flex aspect-square items-center justify-center"><span className="size-2 animate-pulse rounded-full bg-text-muted" /></span>}</button>)}</div> : null}
                    {readyImages.length > 1 ? <button type="button" onClick={() => downloadImages(readyImages)} className="sr-only">Download all</button> : null}
                  </div>;
                })() : null}
                {message.role === "assistant" && message.content ? <div className="mt-2 flex items-center gap-3 text-xs text-text-muted"><button type="button" onClick={() => copyMessage(message)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-surface-2 hover:text-text-main"><span className="material-symbols-outlined text-[15px]">{copiedMessageId === message.id ? "check" : "content_copy"}</span>{copiedMessageId === message.id ? "Copied" : "Copy"}</button></div> : null}
              </div>
              {message.role === "user" ? <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-text-muted"><span className="material-symbols-outlined text-[18px]">person</span></div> : null}
            </div>
          ))}
        </div>

        <div className="z-20 shrink-0 bg-background/95 px-2 py-3 backdrop-blur-sm sm:px-4">
          {error ? <p className="pb-2 text-sm text-red-500">{error}</p> : null}
          {references.length > 0 ? <div className="mb-2 flex gap-2 overflow-x-auto">{references.map((url, index) => <div key={`${url}-${index}`} className="relative shrink-0 pb-1 pr-2 pt-2"><button type="button" onClick={() => setPreviewImage({ src: url })} className="cursor-zoom-in rounded-lg"><img src={url} alt={`Reference ${index + 1}`} className="size-20 rounded-lg object-cover" /></button><button type="button" aria-label="Remove reference image" onClick={() => setReferences((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="absolute right-0 top-0 flex size-5 items-center justify-center rounded-full bg-black/75 text-white"><span className="material-symbols-outlined text-[14px]">close</span></button></div>)}</div> : null}
          <div onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={handleDrop} className="flex items-end gap-2 rounded-2xl border border-border/80 bg-background p-2 shadow-sm focus-within:border-primary">
            <label className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-text-muted hover:bg-surface-2 hover:text-primary"><span className="material-symbols-outlined text-[20px]">attach_file</span><input type="file" accept="image/*" multiple onChange={handleFiles} className="hidden" /></label>
            <textarea ref={promptInputRef} value={prompt} onChange={(event) => { const element = event.currentTarget; element.style.height = "auto"; element.style.height = `${Math.min(element.scrollHeight, 112)}px`; setPrompt(element.value); }} onPaste={handlePaste} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} rows={1} placeholder="Message Image Studio..." className="max-h-28 min-h-9 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-2 text-sm leading-6 outline-none" />
            {sending ? <Button variant="secondary" size="md" icon="stop" onClick={stopJob}>Stop</Button> : <Button size="md" icon="arrow_upward" onClick={sendMessage} disabled={loading || !prompt.trim() || !selectedTextModel || !selectedImageModel}>Send</Button>}
          </div>
        </div>
      </div>

      {previewImage?.src ? <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label="Image preview" onClick={() => setPreviewImage(null)}><div className="relative max-h-full max-w-full" onClick={(event) => event.stopPropagation()}><img src={previewImage.src} alt="Large preview" draggable onDragStart={(event) => handleImageDragStart(event, previewImage.src)} className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain shadow-2xl" /><div className="absolute right-2 top-2 flex gap-2"><button type="button" onClick={() => addImageToChat(previewImage.src)} className="inline-flex h-9 items-center gap-1 rounded-full bg-primary px-3 text-xs font-semibold text-white"><span className="material-symbols-outlined text-[17px]">add_photo_alternate</span>Add to chat</button><a href={previewImage.src} download="9router-image-preview.png" className="flex size-9 items-center justify-center rounded-full bg-black/65 text-white"><span className="material-symbols-outlined text-[18px]">download</span></a><button type="button" onClick={() => setPreviewImage(null)} className="flex size-9 items-center justify-center rounded-full bg-black/65 text-white"><span className="material-symbols-outlined text-[20px]">close</span></button></div></div></div> : null}
    </div>
  );
}
