"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { Button, Badge, Input, Modal, Select } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { planBulkAdd } from "@/shared/utils/bulkAdd";

const BULK_PLACEHOLDER = `name1|sk-key1\nname2|sk-key2\nsk-key-only-auto-named`;

export default function AddApiKeyModal({ isOpen, provider, providerName, isCompatible, isAnthropic, authType, authHint, website, proxyPools, error, existingNames, onSave, onBulkDone, onClose }) {
  const NONE_PROXY_POOL_VALUE = "__none__";
  const isOllamaLocal = provider === "ollama-local";
  const isCookie = authType === "cookie";
  const isXaiApiKey = provider === "xai" && !isCookie;
  const credentialLabel = isCookie ? "Cookie" : provider === "qoder" || provider === "qoder-cn" ? "Personal Access Token (PAT)" : "API Key";
  const credentialPlaceholder = isXaiApiKey ? "xai-..." : provider === "qoder" || provider === "qoder-cn" ? "pt-..." : "";

  const isAzure = provider === "azure";
  const isCloudflareAi = provider === "cloudflare-ai";
  const usesAwsCredentialForm =
    AI_PROVIDERS?.[provider]?.credentialForm === "aws";
  const apiKeyOptionalWith = AI_PROVIDERS?.[provider]?.apiKeyOptionalWith || null;
  const providerRegions = AI_PROVIDERS?.[provider]?.regions || null;
  const defaultRegion = AI_PROVIDERS?.[provider]?.defaultRegion || providerRegions?.[0]?.id || "";

  const [formData, setFormData] = useState({
    name: "",
    apiKey: "",
    defaultModel: "",
    priority: 1,
    proxyPoolId: NONE_PROXY_POOL_VALUE,
    ollamaHostUrl: "",
  });
  const [cookieSourceLabel, setCookieSourceLabel] = useState("");
  const [clipboardError, setClipboardError] = useState("");
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const fileInputRef = useRef(null);

  const [azureData, setAzureData] = useState({
    azureEndpoint: "",
    apiVersion: "2024-10-01-preview",
    deployment: "",
    organization: "",
  });
  const [cloudflareData, setCloudflareData] = useState({ accountId: "" });
  const [bedrockData, setBedrockData] = useState({
    profile: "",
    region: "",
    accessKeyId: "",
    sessionToken: "",
  });
  const [region, setRegion] = useState(defaultRegion);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const bulkPlaceholder = isCloudflareAi
    ? `name1|sk-key1|acc123456\nname2|sk-key2|def789012\nsk-key-only-auto-named`
    : provider === "qoder" || provider === "qoder-cn"
      ? `name1|pt-xxxxx\nname2|pt-yyyyy\npt-only-auto-named`
      : BULK_PLACEHOLDER;

  const [mode, setMode] = useState("single"); // "single" | "bulk"
  const [bulkText, setBulkText] = useState("");
  const [bulkResult, setBulkResult] = useState(null); // { success, failed }

  useEffect(() => {
    if (!isOpen) {
      setCookieSourceLabel("");
      setClipboardError("");
      setIsDraggingFile(false);
      setValidationResult(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !isCookie) return;
    const onWindowPaste = (e) => {
      const tag = e.target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (text) {
        e.preventDefault();
        setClipboardError("");
        setCookieSourceLabel("Đã dán từ Clipboard (Ctrl+V)");
        setFormData((prev) => ({ ...prev, apiKey: text }));
      }
    };
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
  }, [isOpen, isCookie]);

  const handlePasteClipboard = async () => {
    setClipboardError("");
    try {
      const text = (await navigator.clipboard.readText())?.trim();
      if (text) {
        setCookieSourceLabel("Đã dán từ Clipboard");
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
        setCookieSourceLabel(`File: ${file.name}`);
        setFormData((prev) => ({ ...prev, apiKey: text }));
      } else {
        setClipboardError(`File "${file.name}" đang trống.`);
      }
    } catch {
      setClipboardError("Không thể đọc file đã chọn.");
    }
  };

  const buildProviderSpecificData = () => {
    if (isOllamaLocal && formData.ollamaHostUrl.trim()) {
      return { baseUrl: formData.ollamaHostUrl.trim() };
    }
    if (isAzure) {
      return {
        azureEndpoint: azureData.azureEndpoint,
        apiVersion: azureData.apiVersion,
        deployment: azureData.deployment,
        organization: azureData.organization,
      };
    }
    if (isCloudflareAi) {
      return { accountId: cloudflareData.accountId };
    }
    if (usesAwsCredentialForm) {
      const data = {};
      if (bedrockData.profile.trim()) data.profile = bedrockData.profile.trim();
      if (bedrockData.region.trim()) data.region = bedrockData.region.trim();
      if (bedrockData.accessKeyId.trim()) data.accessKeyId = bedrockData.accessKeyId.trim();
      if (bedrockData.sessionToken.trim()) data.sessionToken = bedrockData.sessionToken.trim();
      return Object.keys(data).length ? data : undefined;
    }
    if (providerRegions && region) {
      return { region };
    }
    return undefined;
  };

  const apiKeySatisfied = () => {
    const psd = buildProviderSpecificData();
    if (apiKeyOptionalWith && psd?.[apiKeyOptionalWith]) return true;
    if (usesAwsCredentialForm) return !!formData.apiKey && !!psd?.accessKeyId;
    return !!formData.apiKey;
  };

  const handleValidate = async () => {
    setValidating(true);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: formData.apiKey, providerSpecificData: buildProviderSpecificData() }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
    } catch {
      setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  const handleSubmit = async () => {
    if (!provider) return;
    if (!isOllamaLocal && !apiKeySatisfied()) return;
    if (!isOllamaLocal && !isCookie) {
      if (!formData.name) return;
    }
    if (isCompatible && !formData.defaultModel.trim()) return;

    setSaving(true);
    try {
      let isValid = false;
      let validatedEmail = "";
      let validatedName = "";
      try {
        setValidating(true);
        setValidationResult(null);
        const res = await fetch("/api/providers/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, apiKey: formData.apiKey, providerSpecificData: buildProviderSpecificData() }),
        });
        const data = await res.json();
        isValid = !!data.valid;
        validatedEmail = data.email || "";
        validatedName = data.name || "";
        setValidationResult(isValid ? "success" : "failed");
      } catch {
        setValidationResult("failed");
      } finally {
        setValidating(false);
      }

      await onSave({
        name: formData.name.trim() || validatedEmail || validatedName || (isOllamaLocal ? "Ollama Local" : isCookie ? `${providerName || provider} Cookie` : ""),
        email: validatedEmail || undefined,
        apiKey: formData.apiKey,
        defaultModel: isCompatible ? formData.defaultModel.trim() : undefined,
        priority: formData.priority,
        proxyPoolId: formData.proxyPoolId === NONE_PROXY_POOL_VALUE ? null : formData.proxyPoolId,
        testStatus: isValid ? "active" : "unknown",
        providerSpecificData: buildProviderSpecificData()
      });
    } finally {
      setSaving(false);
    }
  };

  const handleBulkSubmit = async () => {
    const lines = bulkText.split("\n");
    if (!lines.length) return;
    const plan = planBulkAdd(lines, existingNames, { isCloudflareAi });
    if (!plan.length) return;
    setSaving(true);
    setBulkResult(null);
    let success = 0;
    let failed = 0;
    for (const entry of plan) {
      try {
        let isValid = false;
        try {
          const vres = await fetch("/api/providers/validate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider, apiKey: entry.apiKey }),
          });
          const vdata = await vres.json().catch(() => ({}));
          isValid = !!vdata.valid;
        } catch {
          isValid = false;
        }
        const res = await fetch("/api/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider,
            apiKey: entry.apiKey,
            name: entry.name,
            priority: 1,
            testStatus: isValid ? "active" : "unknown",
            ...(entry.providerSpecificData ? { providerSpecificData: entry.providerSpecificData } : {}),
          }),
        });
        if (res.ok) success++;
        else failed++;
      } catch {
        failed++;
      }
    }
    setSaving(false);
    setBulkResult({ success, failed });
    if (success > 0 && onBulkDone) onBulkDone();
  };

  if (!provider) return null;

  return (
    <Modal isOpen={isOpen} title={`Add ${providerName || provider} ${credentialLabel}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {!usesAwsCredentialForm && !isCookie && (
          <div className="flex gap-2">
            <Button size="sm" variant={mode === "single" ? "primary" : "ghost"} onClick={() => { setMode("single"); setBulkResult(null); }}>Single</Button>
            <Button size="sm" variant={mode === "bulk" ? "primary" : "ghost"} onClick={() => { setMode("bulk"); setBulkResult(null); }}>Bulk Add</Button>
          </div>
        )}

        {mode === "bulk" && !isCookie && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-text-muted">
              {isCloudflareAi
                ? <>One key per line. Format: <code>name|apiKey|accountId</code> or just <code>apiKey</code> (auto-named by index).</>
                : provider === "qoder" || provider === "qoder-cn"
                  ? <>One PAT per line. Format: <code>name|pt-...</code> or just <code>pt-...</code> (auto-named by index).</>
                  : <>One key per line. Format: <code>name|apiKey</code> or just <code>apiKey</code> (auto-named by index).</>
              }
            </p>
            <textarea
              className="w-full rounded border border-accent/30 bg-sidebar p-2 text-sm font-mono resize-y min-h-35 focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder={bulkPlaceholder}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
            />
            {bulkResult && (
              <div className={`text-sm font-medium ${bulkResult.failed > 0 ? "text-yellow-400" : "text-green-400"}`}>
                ✓ {bulkResult.success} added{bulkResult.failed > 0 ? `, ✗ ${bulkResult.failed} failed` : ""}
              </div>
            )}
            <div className="flex gap-2">
              <Button onClick={handleBulkSubmit} fullWidth disabled={saving || !bulkText.trim()}>
                {saving ? "Adding..." : "Add All Keys"}
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
            </div>
          </div>
        )}

        {(mode === "single" || isCookie) && (<>
        <Input
          label={isCookie ? "Tên gợi nhớ (tùy chọn)" : "Name"}
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={isOllamaLocal ? "Ollama Local" : isCookie ? `${providerName || provider} Account` : "Production Key"}
        />
        {isOllamaLocal && (
          <div className="flex gap-2">
            <Input
              label="Ollama Host URL"
              value={formData.ollamaHostUrl}
              onChange={(e) => setFormData({ ...formData, ollamaHostUrl: e.target.value })}
              placeholder="http://localhost:11434"
              className="flex-1"
            />
            <div className="pt-6">
              <Button onClick={handleValidate} disabled={validating || saving} variant="secondary">
                {validating ? "Checking..." : "Check"}
              </Button>
            </div>
          </div>
        )}
        {!isOllamaLocal && isCookie && (
          <div className="flex flex-col gap-2.5">
            <input
              ref={fileInputRef}
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
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDraggingFile(false);
                const f = e.dataTransfer?.files?.[0];
                if (f) handleReadCookieFile(f);
              }}
              className={`rounded-xl border border-dashed p-4 transition-colors ${isDraggingFile ? "border-primary bg-primary/5" : "border-border bg-black/2 dark:bg-white/2"}`}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex flex-col items-center justify-center gap-1.5 p-3.5 rounded-lg border border-border bg-background hover:border-primary hover:bg-primary/5 transition-colors text-center"
                >
                  <span className="material-symbols-outlined text-2xl text-primary">upload_file</span>
                  <span className="text-xs font-semibold text-text-main">Chọn File (.txt / .json)</span>
                  <span className="text-[11px] text-text-muted">Hoặc kéo thả file vào đây</span>
                </button>
                <button
                  type="button"
                  onClick={handlePasteClipboard}
                  className="flex flex-col items-center justify-center gap-1.5 p-3.5 rounded-lg border border-border bg-background hover:border-primary hover:bg-primary/5 transition-colors text-center"
                >
                  <span className="material-symbols-outlined text-2xl text-primary">content_paste</span>
                  <span className="text-xs font-semibold text-text-main">Dán từ Clipboard</span>
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

            {formData.apiKey && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="material-symbols-outlined text-[16px] text-emerald-500">check_circle</span>
                  <span className="font-medium truncate">{cookieSourceLabel || "Đã nạp dữ liệu Cookie"}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={handleValidate} disabled={validating || saving} variant="secondary">
                    {validating ? "Checking..." : "Check"}
                  </Button>
                  <button
                    type="button"
                    onClick={() => { setFormData({ ...formData, apiKey: "" }); setCookieSourceLabel(""); setValidationResult(null); }}
                    className="text-xs text-text-muted hover:text-red-500 px-1.5 py-0.5"
                  >
                    Xóa
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {!isOllamaLocal && !isCookie && (
          <div className="flex gap-2">
            <Input
              label={credentialLabel}
              type="password"
              value={formData.apiKey}
              onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
              placeholder={credentialPlaceholder}
              className="flex-1"
            />
            <div className="pt-6">
              <Button onClick={handleValidate} disabled={!apiKeySatisfied() || validating || saving} variant="secondary">
                {validating ? "Checking..." : "Check"}
              </Button>
            </div>
          </div>
        )}
        {isXaiApiKey && (
          <p className="text-xs text-text-muted">
            Use a direct xAI API key from console.x.ai. This is separate from Grok Build OAuth.
          </p>
        )}
        {isCookie && authHint && (
          <p className="text-xs text-text-muted">
            {website && (
              <a href={website} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                Open {website.replace(/^https?:\/\//, "")}
              </a>
            )}
          </p>
        )}
        {providerRegions && (
          <Select
            label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            options={providerRegions.map((r) => ({ value: r.id, label: r.label }))}
          />
        )}
        {isCompatible && (
          <Input
            label="Default Model"
            value={formData.defaultModel}
            onChange={(e) => setFormData({ ...formData, defaultModel: e.target.value })}
            placeholder={isAnthropic ? "claude-3-5-sonnet-latest" : "gpt-4o-mini"}
          />
        )}
        {isOllamaLocal && (
          <p className="text-xs text-text-muted">
            Leave blank to use <code>http://localhost:11434</code>. For remote Ollama, enter the full host URL (e.g. <code>http://192.168.1.10:11434</code>).
          </p>
        )}
        {validationResult && (
          <Badge variant={validationResult === "success" ? "success" : "error"}>
            {validationResult === "success" ? "Valid" : "Invalid"}
          </Badge>
        )}
        {error && (
          <p className="text-xs text-red-500 wrap-break-word">{error}</p>
        )}
        {isCompatible && (
          <p className="text-xs text-text-muted">
            Enter the model ID exactly as your compatible endpoint expects it. This model will be saved as the connection default.
          </p>
        )}
        {isCloudflareAi && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Cloudflare Workers AI</h3>
            <Input
              label="Account ID"
              value={cloudflareData.accountId}
              onChange={(e) => setCloudflareData({ ...cloudflareData, accountId: e.target.value })}
              placeholder="abc123def456..."
            />
            <p className="text-xs text-text-muted mt-2">
              Find your Account ID in the right sidebar of <a href="https://dash.cloudflare.com" target="_blank" rel="noopener noreferrer" className="text-primary underline">dash.cloudflare.com</a>
            </p>
          </div>
        )}
        {usesAwsCredentialForm && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">AWS Bedrock Credentials</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="AWS Profile (SSO — recommended)"
                value={bedrockData.profile}
                onChange={(e) => setBedrockData({ ...bedrockData, profile: e.target.value })}
                placeholder="my-sso-profile"
              />
              <Input
                label="Region"
                value={bedrockData.region}
                onChange={(e) => setBedrockData({ ...bedrockData, region: e.target.value })}
                placeholder="us-east-1"
              />
            </div>
            <p className="text-xs text-text-muted mt-2">
              Set a profile from <code>~/.aws/config</code> and leave the API key empty, then run
              {" "}<code>aws sso login --profile {bedrockData.profile || "my-sso-profile"}</code>.
              Credentials refresh automatically.
            </p>
            <div className="flex flex-col gap-3 mt-4">
              <Input
                label="Access Key ID (only for static keys)"
                value={bedrockData.accessKeyId}
                onChange={(e) => setBedrockData({ ...bedrockData, accessKeyId: e.target.value })}
                placeholder="AKIA..."
              />
              <Input
                label="Session Token (only for temporary ASIA… keys)"
                type="password"
                value={bedrockData.sessionToken}
                onChange={(e) => setBedrockData({ ...bedrockData, sessionToken: e.target.value })}
                placeholder="FwoGZXIvYXdz..."
              />
            </div>
            <p className="text-xs text-text-muted mt-2">
              For static keys instead: put the AWS <strong>secret</strong> access key in the API Key
              field above and the access key id here. A profile, if set, takes precedence.
            </p>
          </div>
        )}
        {isAzure && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Azure OpenAI Configuration</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="Azure Endpoint"
                value={azureData.azureEndpoint}
                onChange={(e) => setAzureData({ ...azureData, azureEndpoint: e.target.value })}
                placeholder="https://your-resource.openai.azure.com"
              />
              <Input
                label="Deployment Name"
                value={azureData.deployment}
                onChange={(e) => setAzureData({ ...azureData, deployment: e.target.value })}
                placeholder="gpt-4"
              />
              <Input
                label="API Version"
                value={azureData.apiVersion}
                onChange={(e) => setAzureData({ ...azureData, apiVersion: e.target.value })}
                placeholder="2024-10-01-preview"
              />
              <Input
                label="Organization"
                value={azureData.organization}
                onChange={(e) => setAzureData({ ...azureData, organization: e.target.value })}
                placeholder="Organization ID"
              />
            </div>
          </div>
        )}

        <Input
          label="Priority"
          type="number"
          value={formData.priority}
          onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value) || 1 })}
        />

        <Select
          label="Proxy Pool"
          value={formData.proxyPoolId}
          onChange={(e) => setFormData({ ...formData, proxyPoolId: e.target.value })}
          options={[
            { value: NONE_PROXY_POOL_VALUE, label: "None" },
            ...(proxyPools || []).map((pool) => ({ value: pool.id, label: pool.name })),
          ]}
          placeholder="None"
        />

        {(proxyPools || []).length === 0 && (
          <p className="text-xs text-text-muted">
            No active proxy pools available. Create one in Proxy Pools page first.
          </p>
        )}

        <p className="text-xs text-text-muted">
          Legacy manual proxy fields are still accepted by API for backward compatibility.
        </p>

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving || (!isOllamaLocal && ((!isCookie && !formData.name) || !apiKeySatisfied())) || (isCompatible && !formData.defaultModel.trim()) || (isAzure && (!azureData.azureEndpoint || !azureData.deployment || !azureData.organization)) || (isCloudflareAi && !cloudflareData.accountId)}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            Cancel
          </Button>
        </div>
        </>)}
      </div>
    </Modal>
  );
}

AddApiKeyModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.string,
  providerName: PropTypes.string,
  isCompatible: PropTypes.bool,
  isAnthropic: PropTypes.bool,
  authType: PropTypes.string,
  authHint: PropTypes.string,
  website: PropTypes.string,
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
  })),
  error: PropTypes.string,
  existingNames: PropTypes.arrayOf(PropTypes.string),
  onSave: PropTypes.func.isRequired,
  onBulkDone: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
