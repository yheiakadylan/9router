"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getStatusVariant as getConnectionStatusVariant } from "@/shared/utils/connectionStatus";
import PropTypes from "prop-types";
import { Card, Badge, Button, Input, Modal, Select, Toggle, EditConnectionModal, ConfirmModal } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import WebLoginButton from "./WebLoginButton";

// ── Universal Cookie Preview Parser ────────────────────────────
// Supports:
// 1. Get cookies.txt LOCALLY / Netscape HTTP Cookie File (.txt)
// 2. J2TEAM Cookies (.json / text: { url, cookies: [...] })
// 3. Cookie-Editor / EditThisCookie / StorageAce ([ { name, value, ... } ])
// 4. Playwright / Puppeteer storageState ({ cookies: [...], origins: [...] })
// 5. HAR (.har) & Key-Value JSON ({ "name": "value" })
// 6. cURL / HTTP Header / Raw Cookie string
function parseNetscapePreviewEntries(trimmed) {
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return null;
  const hasNetscapeHeader = /^#\s*(?:Netscape\s+)?HTTP\s+Cookie\s+File/im.test(trimmed);
  if (!trimmed.includes("\t") && !hasNetscapeHeader) return null;

  const entries = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#HttpOnly_")) {
      line = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#")) {
      continue;
    }
    const cols = line.split("\t");
    if (cols.length >= 6) {
      const expires = Number(cols[4].trim());
      const name = cols[5].trim();
      const value = cols.slice(6).join("\t").trim();
      if (name) {
        entries.push({
          name,
          value,
          domain: cols[0].trim(),
          expirationDate: Number.isFinite(expires) && expires > 0 ? expires : undefined,
        });
      }
    } else {
      const m = line.match(/^(\.?[A-Za-z0-9.-]+)\s+(TRUE|FALSE)\s+(\/\S*)\s+(TRUE|FALSE)\s+(-?\d+)\s+(\S+)\s*(.*)$/i);
      if (m) {
        const expires = Number(m[5].trim());
        entries.push({
          name: m[6].trim(),
          value: (m[7] || "").trim(),
          domain: m[1].trim(),
          expirationDate: Number.isFinite(expires) && expires > 0 ? expires : undefined,
        });
      }
    }
  }
  return entries.length > 0 ? entries : null;
}

function summarizeCookieList(cookies, formatLabel) {
  const byName = new Map();
  for (const c of cookies) {
    if (c && typeof c.name === "string") byName.set(c.name, c);
  }
  const sessionCookie =
    byName.get("__Secure-next-auth.session-token") ||
    byName.get("__Secure-next-auth.session-token.0") ||
    byName.get("sso") ||
    byName.get("__Secure-1PSID") ||
    byName.get("hatch_sess") ||
    byName.get("__client");
  const sessionChunks = cookies.filter((c) => /^__Secure-next-auth\.session-token(?:\.\d+)?$/.test(c?.name || "")).length;
  const hasCfClearance = byName.has("cf_clearance");
  const gn = byName.get("oai-gn")?.value || "";
  const account = byName.get("_account")?.value || "";
  const puidRaw = byName.get("_puid")?.value || "";
  const userId = puidRaw ? puidRaw.split(":")[0] : "";
  const expRaw = sessionCookie?.expirationDate || sessionCookie?.expires;
  const expiresDate = typeof expRaw === "number" && expRaw > 0 ? new Date(expRaw * 1000) : null;
  return {
    format: formatLabel,
    cookieCount: cookies.length,
    hasSession: !!sessionCookie,
    sessionChunks,
    hasCfClearance,
    userName: gn,
    accountType: account,
    userId,
    expiresAt: expiresDate && !Number.isNaN(expiresDate.getTime()) ? expiresDate.toLocaleDateString("vi-VN") : null,
  };
}

function parseCookiePreview(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;

  // 1. JSON formats (J2TEAM, Cookie-Editor, EditThisCookie, StorageState, HAR, Key-Value)
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      let cookies = null;
      let formatLabel = "Cookie JSON";
      if (Array.isArray(parsed)) {
        cookies = parsed;
        formatLabel = "Cookie-Editor / EditThisCookie JSON";
      } else if (Array.isArray(parsed?.cookies)) {
        cookies = parsed.cookies;
        formatLabel = parsed.url ? "J2TEAM Cookies JSON" : "Playwright StorageState JSON";
      } else if (Array.isArray(parsed?.data)) {
        cookies = parsed.data;
      } else if (Array.isArray(parsed?.items)) {
        cookies = parsed.items;
      } else if (Array.isArray(parsed?.log?.entries)) {
        cookies = [];
        for (const entry of parsed.log.entries) {
          if (Array.isArray(entry?.request?.cookies)) cookies.push(...entry.request.cookies);
        }
        formatLabel = "HAR Cookies";
      } else if (parsed && typeof parsed === "object") {
        const keys = Object.keys(parsed);
        if (keys.length > 0 && keys.every((k) => typeof parsed[k] === "string")) {
          cookies = keys.map((k) => ({ name: k, value: parsed[k] }));
          formatLabel = "Key-Value Cookie JSON";
        }
      }
      if (!cookies) return { validJson: false, error: "JSON không chứa danh sách cookies hợp lệ" };
      return summarizeCookieList(cookies, formatLabel);
    } catch {
      return { validJson: false, error: "Định dạng JSON không hợp lệ" };
    }
  }

  // 2. Netscape HTTP Cookie File (Get cookies.txt LOCALLY, Cookie-Editor Netscape, curl)
  const netscapeCookies = parseNetscapePreviewEntries(trimmed);
  if (netscapeCookies) {
    return summarizeCookieList(netscapeCookies, "Get cookies.txt (Netscape)");
  }

  // 3. cURL / Raw HTTP Cookie Header / Bare Session Token
  const hasSession = /__Secure-next-auth\.session-token|sso=|__Secure-1PSID=|hatch_sess=|__client=|^eyJ[A-Za-z0-9_-]+/.test(trimmed);
  const isCurl = /^curl\s+/i.test(trimmed);
  return {
    format: isCurl ? "cURL Command" : trimmed.includes("=") ? "Cookie Header" : "Session Token",
    cookieCount: trimmed.includes(";") ? trimmed.split(";").filter(Boolean).length : 1,
    hasSession,
  };
}

// ── CooldownTimer ──────────────────────────────────────────────
function CooldownTimer({ until }) {
  const [remaining, setRemaining] = useState("");

  useEffect(() => {
    const update = () => {
      const diff = new Date(until).getTime() - Date.now();
      if (diff <= 0) { setRemaining(""); return; }
      const s = Math.floor(diff / 1000);
      if (s < 60) setRemaining(`${s}s`);
      else if (s < 3600) setRemaining(`${Math.floor(s / 60)}m ${s % 60}s`);
      else setRemaining(`${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [until]);

  if (!remaining) return null;
  return <span className="text-xs text-orange-500 font-mono">⏱ {remaining}</span>;
}

CooldownTimer.propTypes = { until: PropTypes.string.isRequired };

// ── ConnectionRow ──────────────────────────────────────────────
function ConnectionRow({ connection, proxyPools, isOAuth, isFirst, isLast, onMoveUp, onMoveDown, onToggleActive, onUpdateProxy, onEdit, onDelete }) {
  const [showProxyDropdown, setShowProxyDropdown] = useState(false);
  const [updatingProxy, setUpdatingProxy] = useState(false);
  const [isCooldown, setIsCooldown] = useState(false);
  const proxyDropdownRef = useRef(null);

  const proxyPoolMap = new Map((proxyPools || []).map((p) => [p.id, p]));
  const boundProxyPoolId = connection.providerSpecificData?.proxyPoolId || null;
  const boundProxyPool = boundProxyPoolId ? proxyPoolMap.get(boundProxyPoolId) : null;
  const hasLegacyProxy = connection.providerSpecificData?.connectionProxyEnabled === true && !!connection.providerSpecificData?.connectionProxyUrl;
  const hasAnyProxy = !!boundProxyPoolId || hasLegacyProxy;

  const proxyDisplayText = boundProxyPool
    ? `Pool: ${boundProxyPool.name}`
    : boundProxyPoolId ? `Pool: ${boundProxyPoolId} (inactive/missing)`
    : hasLegacyProxy ? `Legacy: ${connection.providerSpecificData?.connectionProxyUrl}` : "";

  let maskedProxyUrl = "";
  const rawProxyUrl = boundProxyPool?.proxyUrl || connection.providerSpecificData?.connectionProxyUrl;
  if (rawProxyUrl) {
    try {
      const p = new URL(rawProxyUrl);
      maskedProxyUrl = `${p.protocol}//${p.hostname}${p.port ? `:${p.port}` : ""}`;
    } catch { maskedProxyUrl = rawProxyUrl; }
  }

  const noProxyText = boundProxyPool?.noProxy || connection.providerSpecificData?.connectionNoProxy || "";
  const proxyBadgeVariant = boundProxyPool?.isActive === true ? "success" : (boundProxyPoolId || hasLegacyProxy) ? "error" : "default";

  const modelLockUntil = Object.entries(connection)
    .filter(([k]) => k.startsWith("modelLock_"))
    .map(([, v]) => v).filter(Boolean).sort()[0] || null;

  useEffect(() => {
    const check = () => {
      const until = Object.entries(connection)
        .filter(([k]) => k.startsWith("modelLock_"))
        .map(([, v]) => v).filter(v => v && new Date(v).getTime() > Date.now()).sort()[0] || null;
      setIsCooldown(!!until);
    };
    check();
    const t = modelLockUntil ? setInterval(check, 1000) : null;
    return () => { if (t) clearInterval(t); };
  }, [modelLockUntil]);

  useEffect(() => {
    if (!showProxyDropdown) return;
    const handler = (e) => {
      if (proxyDropdownRef.current && !proxyDropdownRef.current.contains(e.target))
        setShowProxyDropdown(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showProxyDropdown]);

  const effectiveStatus = connection.testStatus === "unavailable" && !isCooldown ? "active" : connection.testStatus;

  const getStatusVariant = () => getConnectionStatusVariant(connection.isActive, effectiveStatus);

  const displayName = connection.email || connection.name || connection.displayName || (isOAuth ? "OAuth Account" : "Connection");
  const subLabel = connection.email && connection.name && connection.name !== connection.email
    ? connection.name
    : connection.providerSpecificData?.accountName && connection.providerSpecificData.accountName !== displayName
      ? connection.providerSpecificData.accountName
      : null;
  const planType = connection.providerSpecificData?.planType || null;

  const handleSelectProxy = async (poolId) => {
    setUpdatingProxy(true);
    try { await onUpdateProxy(poolId === "__none__" ? null : poolId); }
    finally { setUpdatingProxy(false); setShowProxyDropdown(false); }
  };

  return (
    <div className={`group flex flex-col gap-3 p-2 rounded-lg sm:flex-row sm:items-center sm:justify-between hover:bg-black/2 dark:hover:bg-white/2 transition-colors ${connection.isActive === false ? "opacity-60" : ""}`}>
      <div className="flex w-full min-w-0 flex-1 items-start gap-3 sm:items-center">
        <div className="flex flex-col">
          <button onClick={onMoveUp} disabled={isFirst} className={`p-0.5 rounded ${isFirst ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}>
            <span className="material-symbols-outlined text-sm">keyboard_arrow_up</span>
          </button>
          <button onClick={onMoveDown} disabled={isLast} className={`p-0.5 rounded ${isLast ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}>
            <span className="material-symbols-outlined text-sm">keyboard_arrow_down</span>
          </button>
        </div>
        <span className="material-symbols-outlined text-base text-text-muted">{isOAuth ? "lock" : "key"}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <p className="text-sm font-medium truncate">{displayName}</p>
            {subLabel && <span className="text-xs text-text-muted truncate">({subLabel})</span>}
            {planType && <Badge variant="primary" size="sm">{String(planType).toUpperCase()}</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <Badge variant={getStatusVariant()} size="sm" dot>
              {connection.isActive === false ? "disabled" : (effectiveStatus || "Unknown")}
            </Badge>
            {hasAnyProxy && <Badge variant={proxyBadgeVariant} size="sm">Proxy</Badge>}
            {isCooldown && connection.isActive !== false && <CooldownTimer until={modelLockUntil} />}
            {connection.lastError && connection.isActive !== false && (
              <span className="text-xs text-red-500 truncate max-w-75" title={connection.lastError}>{connection.lastError}</span>
            )}
            <span className="text-xs text-text-muted">#{connection.priority}</span>
          </div>
          {hasAnyProxy && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-text-muted truncate max-w-105" title={proxyDisplayText}>{proxyDisplayText}</span>
              {maskedProxyUrl && <code className="text-[10px] font-mono bg-black/5 dark:bg-white/5 px-1 py-0.5 rounded text-text-muted">{maskedProxyUrl}</code>}
              {noProxyText && <span className="text-[11px] text-text-muted truncate max-w-[320px]" title={noProxyText}>no_proxy: {noProxyText}</span>}
            </div>
          )}
        </div>
      </div>
      <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
        <div className="flex flex-wrap gap-1">
          {(proxyPools || []).length > 0 && (
            <div className="relative" ref={proxyDropdownRef}>
              <button
                onClick={() => setShowProxyDropdown((v) => !v)}
                className={`flex flex-col items-center px-2 py-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors ${hasAnyProxy ? "text-primary" : "text-text-muted hover:text-primary"}`}
                disabled={updatingProxy}
              >
                <span className="material-symbols-outlined text-[18px]">{updatingProxy ? "progress_activity" : "lan"}</span>
                <span className="text-[10px] leading-tight">Proxy</span>
              </button>
              {showProxyDropdown && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-bg border border-border rounded-lg shadow-lg py-1 min-w-40">
                  <button onClick={() => handleSelectProxy("__none__")} className={`w-full text-left px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5 ${!boundProxyPoolId ? "text-primary font-medium" : "text-text-main"}`}>None</button>
                  {(proxyPools || []).map((pool) => (
                    <button key={pool.id} onClick={() => handleSelectProxy(pool.id)} className={`w-full text-left px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5 ${boundProxyPoolId === pool.id ? "text-primary font-medium" : "text-text-main"}`}>{pool.name}</button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button onClick={onEdit} className="flex flex-col items-center px-2 py-1 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary">
            <span className="material-symbols-outlined text-[18px]">edit</span>
            <span className="text-[10px] leading-tight">Edit</span>
          </button>
          <button onClick={onDelete} className="flex flex-col items-center px-2 py-1 rounded hover:bg-red-500/10 text-red-500">
            <span className="material-symbols-outlined text-[18px]">delete</span>
            <span className="text-[10px] leading-tight">Delete</span>
          </button>
        </div>
        <Toggle size="sm" checked={connection.isActive ?? true} onChange={onToggleActive} title={(connection.isActive ?? true) ? "Disable" : "Enable"} />
      </div>
    </div>
  );
}

ConnectionRow.propTypes = {
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    displayName: PropTypes.string,
    testStatus: PropTypes.string,
    isActive: PropTypes.bool,
    lastError: PropTypes.string,
    priority: PropTypes.number,
    providerSpecificData: PropTypes.object,
  }).isRequired,
  proxyPools: PropTypes.array,
  isOAuth: PropTypes.bool.isRequired,
  isFirst: PropTypes.bool.isRequired,
  isLast: PropTypes.bool.isRequired,
  onMoveUp: PropTypes.func.isRequired,
  onMoveDown: PropTypes.func.isRequired,
  onToggleActive: PropTypes.func.isRequired,
  onUpdateProxy: PropTypes.func,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
};

// ── AddApiKeyModal ─────────────────────────────────────────────
function AddApiKeyModal({ isOpen, provider, providerName, proxyPools, onSave, onClose }) {
  const NONE = "__none__";
  const providerInfo = provider ? AI_PROVIDERS[provider] : null;
  const isCookie = providerInfo?.authType === "cookie";
  const displayProviderName = providerName || providerInfo?.name || provider;
  const [formData, setFormData] = useState({ name: "", apiKey: "", priority: 1, proxyPoolId: NONE });
  const [cookieSourceLabel, setCookieSourceLabel] = useState("");
  const [clipboardError, setClipboardError] = useState("");
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [identityInfo, setIdentityInfo] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const modalFileInputRef = useRef(null);

  useEffect(() => {
    if (!isOpen) {
      setFormData({ name: "", apiKey: "", priority: 1, proxyPoolId: NONE });
      setCookieSourceLabel("");
      setClipboardError("");
      setIsDraggingFile(false);
      setValidationResult(null);
      setIdentityInfo(null);
      setShowAdvanced(false);
    }
  }, [isOpen]);

  // Support Ctrl+V anywhere while Cookie modal is open (excluding name/priority input)
  useEffect(() => {
    if (!isOpen || !isCookie) return;
    const onWindowPaste = (e) => {
      const tag = e.target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (text) {
        e.preventDefault();
        setClipboardError("");
        setCookieSourceLabel("Clipboard");
        setFormData((prev) => ({ ...prev, apiKey: text }));
      }
    };
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
  }, [isOpen, isCookie]);

  const preview = isCookie ? parseCookiePreview(formData.apiKey) : null;

  const runValidation = useCallback(async (rawKey) => {
    if (!provider || !rawKey?.trim()) return null;
    setValidating(true);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: rawKey.trim() }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
      if (data.valid) {
        setIdentityInfo({
          email: data.email || null,
          name: data.name || null,
          planType: data.planType || null,
          accountStructure: data.accountStructure || null,
          expires: data.expires || null,
        });
      } else {
        setIdentityInfo(data.error ? { error: data.error } : null);
      }
      return data;
    } catch {
      setValidationResult("failed");
      return null;
    } finally {
      setValidating(false);
    }
  }, [provider]);

  useEffect(() => {
    if (!isCookie || !formData.apiKey.trim()) {
      setValidationResult(null);
      setIdentityInfo(null);
      return;
    }
    const p = parseCookiePreview(formData.apiKey);
    if (!p?.hasSession) return;
    const t = setTimeout(() => {
      runValidation(formData.apiKey);
    }, 300);
    return () => clearTimeout(t);
  }, [isCookie, formData.apiKey, runValidation]);

  const handlePasteClipboard = async () => {
    setClipboardError("");
    try {
      const text = (await navigator.clipboard.readText())?.trim();
      if (text) {
        setCookieSourceLabel("Clipboard");
        setFormData((prev) => ({ ...prev, apiKey: text }));
      } else {
        setClipboardError("Clipboard đang trống. Hãy copy cookie trước hoặc nhấn Ctrl+V.");
      }
    } catch {
      setClipboardError("Trình duyệt chặn đọc Clipboard tự động — hãy nhấn tổ hợp phím Ctrl+V ngay tại cửa sổ này.");
    }
  };

  const handleReadCookieFile = async (file) => {
    if (!file) return;
    setClipboardError("");
    try {
      const text = (await file.text())?.trim();
      if (text) {
        setCookieSourceLabel(file.name);
        setFormData((prev) => ({ ...prev, apiKey: text }));
      } else {
        setClipboardError(`File "${file.name}" đang trống.`);
      }
    } catch {
      setClipboardError("Không thể đọc file đã chọn.");
    }
  };

  const handleFileDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) await handleReadCookieFile(file);
  };

  const handleClearCookie = () => {
    setFormData((prev) => ({ ...prev, apiKey: "" }));
    setCookieSourceLabel("");
    setClipboardError("");
    setValidationResult(null);
    setIdentityInfo(null);
  };

  const handleSubmit = async () => {
    if (!provider || !formData.apiKey.trim()) return;
    setSaving(true);
    try {
      let data = identityInfo && validationResult === "success" ? { valid: true, ...identityInfo } : null;
      if (!data) {
        data = await runValidation(formData.apiKey);
      }
      const isValid = !!data?.valid;
      const autoName =
        formData.name.trim() ||
        data?.email ||
        (preview?.userName ? `${preview.userName}${preview.accountType ? ` (${preview.accountType})` : ""}` : "") ||
        (isCookie ? `${displayProviderName} Cookie` : "Default");

      await onSave({
        name: autoName,
        email: data?.email || undefined,
        apiKey: formData.apiKey.trim(),
        authType: isCookie ? "cookie" : undefined,
        priority: formData.priority,
        proxyPoolId: formData.proxyPoolId === NONE ? null : formData.proxyPoolId,
        testStatus: isValid ? "active" : "unknown",
      });
    } finally { setSaving(false); }
  };

  if (!provider) return null;

  const autoSuggestedName =
    identityInfo?.email ||
    (preview?.userName ? `${preview.userName}${preview.accountType ? ` (${preview.accountType})` : ""}` : `${displayProviderName} Account`);

  return (
    <Modal isOpen={isOpen} title={isCookie ? `Add ${displayProviderName} Connection` : `Add ${displayProviderName} API Key`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {isCookie ? (
          <>
            <input
              ref={modalFileInputRef}
              type="file"
              accept=".txt,.json,.cookies,.har,text/plain,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleReadCookieFile(f);
                e.target.value = "";
              }}
            />

            <div
              onDragOver={(e) => { e.preventDefault(); setIsDraggingFile(true); }}
              onDragLeave={() => setIsDraggingFile(false)}
              onDrop={handleFileDrop}
              className={`rounded-xl border border-dashed p-3.5 transition-colors ${isDraggingFile ? "border-primary bg-primary/5" : "border-border bg-black/2 dark:bg-white/2"}`}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => modalFileInputRef.current?.click()}
                  className="flex flex-col items-center justify-center gap-1 p-3 rounded-lg border border-border bg-background hover:border-primary hover:bg-primary/5 transition-colors text-center"
                >
                  <span className="material-symbols-outlined text-2xl text-primary leading-none">upload_file</span>
                  <span className="text-xs font-semibold text-text-main mt-0.5">Chọn File (.txt / .json)</span>
                  <span className="text-[11px] text-text-muted">Hoặc kéo thả file vào đây</span>
                </button>

                <button
                  type="button"
                  onClick={handlePasteClipboard}
                  className="flex flex-col items-center justify-center gap-1 p-3 rounded-lg border border-border bg-background hover:border-primary hover:bg-primary/5 transition-colors text-center"
                >
                  <span className="material-symbols-outlined text-2xl text-primary leading-none">content_paste</span>
                  <span className="text-xs font-semibold text-text-main mt-0.5">Dán từ Clipboard</span>
                  <span className="text-[11px] text-text-muted">Bấm vào đây hoặc nhấn Ctrl+V</span>
                </button>
              </div>

              <p className="mt-2.5 text-center text-[11px] text-text-muted">
                Hỗ trợ: Get cookies.txt LOCALLY (.txt) • J2TEAM Cookies (.json) • Cookie-Editor • EditThisCookie
              </p>
            </div>

            {clipboardError && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                {clipboardError}
              </div>
            )}

            {formData.apiKey && preview && (
              <div className={`rounded-xl border p-3 text-xs flex flex-col gap-2 ${preview.hasSession ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5"}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-medium min-w-0">
                    <span className={`material-symbols-outlined text-[16px] shrink-0 ${preview.hasSession ? "text-emerald-500" : "text-amber-500"}`}>
                      {preview.hasSession ? "check_circle" : "warning"}
                    </span>
                    <span className="truncate">{preview.format || "Cookie"}</span>
                    {preview.cookieCount > 0 && (
                      <span className="text-text-muted font-normal shrink-0">({preview.cookieCount})</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {validating ? (
                      <span className="text-text-muted flex items-center gap-1">
                        <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                        Đang kiểm tra...
                      </span>
                    ) : validationResult === "success" ? (
                      <Badge variant="success" size="sm">Session Hợp lệ</Badge>
                    ) : validationResult === "failed" ? (
                      <Badge variant="error" size="sm">{identityInfo?.error || "Session Lỗi"}</Badge>
                    ) : null}
                    <button
                      type="button"
                      onClick={handleClearCookie}
                      className="text-xs text-text-muted hover:text-red-500 px-1.5 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                      Xóa
                    </button>
                  </div>
                </div>

                {(identityInfo?.email || preview.userName || preview.expiresAt) && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-text-main pt-1.5 border-t border-black/5 dark:border-white/5">
                    {identityInfo?.email && (
                      <span><strong className="text-text-muted font-normal">Email:</strong> {identityInfo.email}</span>
                    )}
                    {(identityInfo?.name || preview.userName) && (
                      <span><strong className="text-text-muted font-normal">Tên:</strong> {identityInfo?.name || preview.userName}</span>
                    )}
                    {(identityInfo?.planType || preview.accountType) && (
                      <span>
                        <strong className="text-text-muted font-normal">Gói:</strong>{" "}
                        <span className="uppercase font-semibold text-primary">{identityInfo?.planType || preview.accountType}</span>
                      </span>
                    )}
                    {preview.expiresAt && (
                      <span><strong className="text-text-muted font-normal">Hết hạn:</strong> {preview.expiresAt}</span>
                    )}
                  </div>
                )}

                {preview.error && (
                  <p className="text-red-500">{preview.error}</p>
                )}

                {!preview.error && !preview.hasSession && (
                  <p className="text-amber-600 dark:text-amber-400">
                    Không tìm thấy cookie phiên đăng nhập (<code>__Secure-next-auth.session-token</code>). Hãy chắc chắn bạn đã đăng nhập trên web trước khi xuất cookie.
                  </p>
                )}
              </div>
            )}

            <Input
              label="Tên gợi nhớ (tùy chọn)"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder={autoSuggestedName}
              hint="Bỏ trống sẽ tự động đặt theo email hoặc tên tài khoản"
            />

            <div className="border-t border-border/60 pt-2.5">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-text-muted hover:text-text-main transition-colors"
              >
                <span className="material-symbols-outlined text-[16px] leading-none">
                  {showAdvanced ? "keyboard_arrow_up" : "keyboard_arrow_down"}
                </span>
                <span>Tùy chọn nâng cao (Priority & Proxy)</span>
              </button>

              {showAdvanced && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                  <Input
                    label="Priority"
                    type="number"
                    min={1}
                    value={formData.priority}
                    onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value) || 1 })}
                  />
                  <Select
                    label="Proxy Pool"
                    value={formData.proxyPoolId}
                    onChange={(e) => setFormData({ ...formData, proxyPoolId: e.target.value })}
                    options={[{ value: NONE, label: "None" }, ...(proxyPools || []).map((p) => ({ value: p.id, label: p.name }))]}
                  />
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <Input
              label="Name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="Production Key"
            />
            <div className="flex gap-2">
              <Input
                label="API Key"
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                className="flex-1"
              />
              <div className="pt-6">
                <Button onClick={() => runValidation(formData.apiKey)} disabled={!formData.apiKey || validating || saving} variant="secondary">
                  {validating ? "Checking..." : "Check"}
                </Button>
              </div>
            </div>
            {validationResult && (
              <Badge variant={validationResult === "success" ? "success" : "error"}>
                {validationResult === "success" ? "Valid" : "Invalid"}
              </Badge>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="Priority"
                type="number"
                min={1}
                value={formData.priority}
                onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value) || 1 })}
              />
              <Select
                label="Proxy Pool"
                value={formData.proxyPoolId}
                onChange={(e) => setFormData({ ...formData, proxyPoolId: e.target.value })}
                options={[{ value: NONE, label: "None" }, ...(proxyPools || []).map((p) => ({ value: p.id, label: p.name }))]}
              />
            </div>
          </>
        )}

        <div className="flex gap-2 pt-1">
          <Button onClick={handleSubmit} fullWidth disabled={(!isCookie && !formData.name) || !formData.apiKey.trim() || saving || validating}>
            {saving ? "Đang lưu..." : isCookie ? "Lưu Connection" : "Save"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

AddApiKeyModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.string,
  providerName: PropTypes.string,
  proxyPools: PropTypes.array,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

// ── ConnectionsCard ────────────────────────────────────────────
// Self-contained card: fetches, displays and manages all connections for a provider.
export default function ConnectionsCard({ providerId, isOAuth, loginProviderId = null }) {
  const [connections, setConnections] = useState([]);
  const [proxyPools, setProxyPools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [providerStrategy, setProviderStrategy] = useState(null);
  const [providerStickyLimit, setProviderStickyLimit] = useState("1");
  const [confirmState, setConfirmState] = useState(null);

  const fetch_ = useCallback(async () => {
    try {
      const [connRes, proxyRes, settingsRes] = await Promise.all([
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }),
        fetch("/api/settings", { cache: "no-store" }),
      ]);
      const connData = await connRes.json();
      const proxyData = await proxyRes.json();
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      if (connRes.ok) setConnections((connData.connections || []).filter((c) => c.provider === providerId));
      if (proxyRes.ok) setProxyPools(proxyData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProviderStrategy(override.fallbackStrategy || null);
      setProviderStickyLimit(override.stickyRoundRobinLimit != null ? String(override.stickyRoundRobinLimit) : "1");
    } catch (e) { console.log("ConnectionsCard fetch error:", e); }
    finally { setLoading(false); }
  }, [providerId]);

  useEffect(() => { fetch_(); }, [fetch_]);

  const saveStrategy = async (strategy, stickyLimit) => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = {};
      if (strategy) override.fallbackStrategy = strategy;
      if (strategy === "round-robin" && stickyLimit !== "") override.stickyRoundRobinLimit = Number(stickyLimit) || 3;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerStrategies: updated }) });
    } catch (e) { console.log("saveStrategy error:", e); }
  };

  const handleSwapPriority = async (i1, i2) => {
    const next = [...connections];
    [next[i1], next[i2]] = [next[i2], next[i1]];
    setConnections(next);
    try {
      await Promise.all([
        fetch(`/api/providers/${next[i1].id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ priority: i1 }) }),
        fetch(`/api/providers/${next[i2].id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ priority: i2 }) }),
      ]);
    } catch { await fetch_(); }
  };

  const handleDelete = async (id) => {
    setConfirmState({
      title: "Delete Connection",
      message: "Delete this connection?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
          if (res.ok) setConnections((prev) => prev.filter((c) => c.id !== id));
        } catch (e) { console.log("delete error:", e); }
      }
    });
  };

  const handleToggleActive = async (id, isActive) => {
    try {
      const res = await fetch(`/api/providers/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive }) });
      if (res.ok) setConnections((prev) => prev.map((c) => c.id === id ? { ...c, isActive } : c));
    } catch (e) { console.log("toggle error:", e); }
  };

  const handleUpdateProxy = async (connId, proxyPoolId) => {
    try {
      const res = await fetch(`/api/providers/${connId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proxyPoolId: proxyPoolId || null }) });
      if (res.ok) setConnections((prev) => prev.map((c) => c.id === connId ? { ...c, providerSpecificData: { ...c.providerSpecificData, proxyPoolId: proxyPoolId || null } } : c));
    } catch (e) { console.log("proxy error:", e); }
  };

  const handleSaveApiKey = async (formData) => {
    try {
      const res = await fetch("/api/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: providerId, ...formData }) });
      if (res.ok) { await fetch_(); setShowAddModal(false); }
    } catch (e) { console.log("save apikey error:", e); }
  };

  const handleUpdateConnection = async (formData) => {
    try {
      const res = await fetch(`/api/providers/${selectedConnection.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(formData) });
      if (res.ok) { await fetch_(); setShowEditModal(false); }
    } catch (e) { console.log("update connection error:", e); }
  };

  if (loading) return <Card><div className="h-20 animate-pulse bg-black/5 rounded-lg" /></Card>;

  return (
    <>
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
          <h2 className="text-lg font-semibold">Connections</h2>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-text-muted font-medium">Round Robin</span>
            <Toggle
              checked={providerStrategy === "round-robin"}
              onChange={(enabled) => {
                const strategy = enabled ? "round-robin" : null;
                setProviderStrategy(strategy);
                if (enabled && !providerStickyLimit) setProviderStickyLimit("1");
                saveStrategy(strategy, enabled ? (providerStickyLimit || "1") : providerStickyLimit);
              }}
            />
            {providerStrategy === "round-robin" && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-text-muted">Sticky:</span>
                <input
                  type="number" min={1} value={providerStickyLimit}
                  onChange={(e) => { setProviderStickyLimit(e.target.value); saveStrategy("round-robin", e.target.value); }}
                  className="w-16 px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:border-primary"
                />
              </div>
            )}
          </div>
        </div>

        {connections.length === 0 ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-text-muted">No connections yet</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon="add" onClick={() => setShowAddModal(true)}>Add Connection</Button>
              {loginProviderId && (
                <WebLoginButton providerId={loginProviderId} onConnected={fetch_} />
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col divide-y divide-black/3 dark:divide-white/3 max-h-125 overflow-y-auto pr-1">
              {connections.map((conn, idx) => (
                <ConnectionRow
                  key={conn.id}
                  connection={conn}
                  proxyPools={proxyPools}
                  isOAuth={isOAuth}
                  isFirst={idx === 0}
                  isLast={idx === connections.length - 1}
                  onMoveUp={() => handleSwapPriority(idx, idx - 1)}
                  onMoveDown={() => handleSwapPriority(idx, idx + 1)}
                  onToggleActive={(isActive) => handleToggleActive(conn.id, isActive)}
                  onUpdateProxy={(poolId) => handleUpdateProxy(conn.id, poolId)}
                  onEdit={() => { setSelectedConnection(conn); setShowEditModal(true); }}
                  onDelete={() => handleDelete(conn.id)}
                />
              ))}
            </div>
            <div className="mt-4 flex flex-wrap justify-stretch gap-2 sm:justify-start">
              <Button size="sm" icon="add" onClick={() => setShowAddModal(true)}>Add Connection</Button>
              {loginProviderId && (
                <WebLoginButton providerId={loginProviderId} onConnected={fetch_} />
              )}
            </div>
          </>
        )}
      </Card>

      <AddApiKeyModal
        isOpen={showAddModal}
        provider={providerId}
        proxyPools={proxyPools}
        onSave={handleSaveApiKey}
        onClose={() => setShowAddModal(false)}
      />
      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => setShowEditModal(false)}
      />

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </>
  );
}

ConnectionsCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  isOAuth: PropTypes.bool,
  loginProviderId: PropTypes.string,
};
