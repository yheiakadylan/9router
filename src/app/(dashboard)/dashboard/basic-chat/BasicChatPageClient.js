"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/shared/components";
import { getModelKind, getModelsByProviderId } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { Row } from "@/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/exampleShared";

const API_PATH = "/v1/chat/completions";
const DEFAULT_RESPONSE = `{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "..."
      }
    }
  ]
}`;

function textValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
  }
  return "";
}

function readAssistantText(chunk) {
  const choice = chunk?.choices?.[0];
  return textValue(choice?.delta?.content)
    || textValue(choice?.message?.content)
    || textValue(chunk?.output_text)
    || textValue(chunk?.text);
}

function parseModels(data) {
  if (Array.isArray(data?.models)) return data.models;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  return Array.isArray(data) ? data : [];
}

function normalizeLiveModel(model, providerId) {
  const rawId = typeof model === "string" ? model : model?.id || model?.name || model?.model || "";
  if (!rawId) return null;
  const providerAlias = getProviderAlias(providerId);
  const requestModel = rawId.startsWith(`${providerAlias}/`) || rawId.startsWith(`${providerId}/`)
    ? rawId
    : `${providerAlias}/${rawId}`;
  return {
    id: requestModel,
    requestModel,
    name: typeof model === "string" ? model : model?.name || model?.displayName || rawId,
    providerId,
  };
}

function dedupeModels(models) {
  return Array.from(new Map(models.filter(Boolean).map((model) => [model.requestModel, model])).values());
}

function buildCurl({ endpoint, apiKey, connectionId, body }) {
  return `curl -X POST ${endpoint}${API_PATH} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey || "YOUR_KEY"}"${connectionId ? ` \\
  -H "x-connection-id: ${connectionId}"` : ""}${body.stream ? ` \\
  -H "Accept: text/event-stream"` : ""} \\
  -d '${JSON.stringify(body)}'`;
}

function now() {
  return Date.now();
}

export default function BasicChatPageClient() {
  const [providerGroups, setProviderGroups] = useState([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [pinnedConnectionId, setPinnedConnectionId] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("You are a helpful assistant.");
  const [message, setMessage] = useState("Hello! Introduce yourself in one sentence.");
  const [temperature, setTemperature] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [stream, setStream] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [localEndpoint, setLocalEndpoint] = useState("");
  const [tunnelEndpoint, setTunnelEndpoint] = useState("");
  const [useTunnel, setUseTunnel] = useState(false);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const abortRef = useRef(null);
  const { copied: copiedCurl, copy: copyCurl } = useCopyToClipboard();
  const { copied: copiedResult, copy: copyResult } = useCopyToClipboard();

  useEffect(function loadChatOptions() {
    let cancelled = false;

    async function load() {
      try {
        const [providersResponse, keysResponse, tunnelResponse, customResponse] = await Promise.all([
          fetch("/api/providers", { cache: "no-store" }),
          fetch("/api/keys"),
          fetch("/api/tunnel/status"),
          fetch("/api/models/custom", { cache: "no-store" }),
        ]);
        const [providersData, keysData, tunnelData, customData] = await Promise.all([
          providersResponse.json().catch(() => ({})),
          keysResponse.json().catch(() => ({})),
          tunnelResponse.json().catch(() => ({})),
          customResponse.json().catch(() => ({})),
        ]);
        if (cancelled) return;

        setLocalEndpoint(window.location.origin);
        setApiKey((keysData.keys || []).find((key) => key.isActive !== false)?.key || "");
        setTunnelEndpoint(tunnelData.publicUrl || "");

        const connections = (providersData.connections || []).filter((connection) => connection.isActive !== false);
        const customModels = customData.models || [];
        const groups = new Map();
        for (const connection of connections) {
          const providerId = connection.provider || connection.id;
          if (!groups.has(providerId)) {
            const staticModels = getModelsByProviderId(providerId)
              .filter((model) => !getModelKind(model) || getModelKind(model) === "llm")
              .map((model) => ({
                id: `${getProviderAlias(providerId)}/${model.id}`,
                requestModel: `${getProviderAlias(providerId)}/${model.id}`,
                name: model.name || model.id,
                providerId,
              }));
            groups.set(providerId, {
              providerId,
              providerName: connection.name || providerId.replace(/[-_]/g, " "),
              connections: [],
              models: staticModels,
            });
          }
          groups.get(providerId).connections.push(connection);
        }

        const liveResults = await Promise.all(connections.map(async (connection) => {
          try {
            const response = await fetch(`/api/providers/${connection.id}/models`, { cache: "no-store" });
            if (!response.ok) return [];
            return parseModels(await response.json()).map((model) => normalizeLiveModel(model, connection.provider || connection.id));
          } catch {
            return [];
          }
        }));
        if (cancelled) return;

        liveResults.flat().forEach((model) => {
          if (model && groups.has(model.providerId)) groups.get(model.providerId).models.push(model);
        });
        for (const customModel of customModels) {
          if (!customModel?.id || getModelKind(customModel, "llm") !== "llm") continue;
          const group = Array.from(groups.values()).find((entry) => getProviderAlias(entry.providerId) === customModel.providerAlias);
          if (!group) continue;
          const requestModel = `${customModel.providerAlias}/${customModel.id}`;
          group.models.push({
            id: requestModel,
            requestModel,
            name: customModel.name || customModel.id,
            providerId: group.providerId,
          });
        }
        setProviderGroups(Array.from(groups.values())
          .map((group) => ({ ...group, models: dedupeModels(group.models) }))
          .filter((group) => group.models.length > 0));
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || "Failed to load providers and models.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, []);

  const models = useMemo(() => providerGroups.flatMap((group) => group.models), [providerGroups]);
  const selectedModel = models.find((model) => model.id === selectedModelId) || models[0] || null;
  const selectedGroup = providerGroups.find((group) => group.providerId === selectedModel?.providerId) || null;
  const endpoint = useTunnel && tunnelEndpoint ? tunnelEndpoint : localEndpoint;
  const messages = [
    ...(systemPrompt.trim() ? [{ role: "system", content: systemPrompt.trim() }] : []),
    { role: "user", content: message },
  ];
  const requestBody = {
    model: selectedModel?.requestModel || "",
    messages,
    stream,
    ...(temperature !== "" ? { temperature: Number(temperature) } : {}),
    ...(maxTokens !== "" ? { max_tokens: Number(maxTokens) } : {}),
  };
  const curl = buildCurl({ endpoint, apiKey, connectionId: pinnedConnectionId, body: requestBody });
  const resultJson = result ? JSON.stringify(result.data, null, 2) : DEFAULT_RESPONSE;

  const handleModelChange = (event) => {
    setSelectedModelId(event.target.value);
    setPinnedConnectionId("");
  };

  const handleRun = async () => {
    if (!selectedModel || !message.trim() || running) return;
    setRunning(true);
    setError("");
    setResult(null);
    abortRef.current = new AbortController();
    const startedAt = now();

    try {
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      if (pinnedConnectionId) headers["x-connection-id"] = pinnedConnectionId;
      if (stream) headers.Accept = "text/event-stream";

      const response = await fetch(`/api${API_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: abortRef.current.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error?.message || data?.error || `HTTP ${response.status}`);
      }

      const servedConnectionId = response.headers.get("x-connection-id") || "";
      const servedConnection = selectedGroup?.connections.find((connection) => connection.id === servedConnectionId);
      const connectionLabel = servedConnection?.email || servedConnection?.name || servedConnectionId.slice(0, 8);
      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream") && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let assistantText = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              assistantText += readAssistantText(JSON.parse(payload));
              setResult({
                data: { choices: [{ message: { role: "assistant", content: assistantText } }] },
                latencyMs: now() - startedAt,
                connectionLabel,
              });
            } catch {}
          }
        }
      } else {
        setResult({ data: await response.json(), latencyMs: now() - startedAt, connectionLabel });
      }
    } catch (runError) {
      if (runError.name !== "AbortError") setError(runError.message || "Network error");
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <Card>
        <h2 className="mb-4 text-lg font-semibold">Example</h2>
        <div className="flex flex-col gap-2.5">
          <Row label="Model">
            <select
              value={selectedModel?.id || ""}
              onChange={handleModelChange}
              disabled={loading || models.length === 0}
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none disabled:opacity-60"
            >
              {models.length === 0 ? <option value="">{loading ? "Loading models..." : "No models available"}</option> : null}
              {providerGroups.map((group) => (
                <optgroup key={group.providerId} label={group.providerName}>
                  {group.models.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
                </optgroup>
              ))}
            </select>
          </Row>

          <Row label="Endpoint">
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <span className="w-full min-w-0 flex-1 truncate rounded-lg bg-sidebar px-3 py-1.5 font-mono text-sm text-text-main">{endpoint}{API_PATH}</span>
              {tunnelEndpoint ? (
                <button
                  type="button"
                  onClick={() => setUseTunnel((value) => !value)}
                  className={`flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1.5 text-xs transition-colors ${useTunnel ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-text-muted hover:text-primary"}`}
                >
                  <span className="material-symbols-outlined text-[14px]">wifi_tethering</span>
                  Tunnel
                </button>
              ) : null}
            </div>
          </Row>

          <Row label="API Key">
            <span className="block truncate rounded-lg bg-sidebar px-3 py-1.5 font-mono text-sm text-text-main">
              {apiKey ? `${apiKey.slice(0, 8)}${"\u2022".repeat(Math.min(20, Math.max(0, apiKey.length - 8)))}` : <span className="italic text-text-muted">No key configured</span>}
            </span>
          </Row>

          <Row label="Connection">
            <select
              value={pinnedConnectionId}
              onChange={(event) => setPinnedConnectionId(event.target.value)}
              disabled={!selectedGroup || selectedGroup.connections.length === 0}
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none disabled:opacity-60"
            >
              <option value="">Auto (by priority)</option>
              {(selectedGroup?.connections || []).map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.email || connection.name || connection.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </Row>

          <Row label="System">
            <input value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} placeholder="Optional system prompt" className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none" />
          </Row>

          <Row label="Message">
            <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} placeholder="Ask anything..." className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none" />
          </Row>

          <Row label="Temperature">
            <input type="number" min="0" max="2" step="0.1" value={temperature} onChange={(event) => setTemperature(event.target.value)} placeholder="Optional" className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none" />
          </Row>

          <Row label="Max Tokens">
            <input type="number" min="1" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} placeholder="Optional" className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none" />
          </Row>

          <Row label="Stream">
            <select value={stream ? "true" : "false"} onChange={(event) => setStream(event.target.value === "true")} className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </Row>

          <div className="mt-1">
            <div className="mb-1.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">Request</span>
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                <button type="button" onClick={() => copyCurl(curl)} className="inline-flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-primary">
                  <span className="material-symbols-outlined text-[14px]">{copiedCurl ? "check" : "content_copy"}</span>
                  {copiedCurl ? "Copied" : "Copy"}
                </button>
                <button type="button" onClick={handleRun} disabled={running || !selectedModel || !message.trim()} className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">
                  <span className="material-symbols-outlined text-[14px]" style={running ? { animation: "spin 1s linear infinite" } : undefined}>play_arrow</span>
                  {running ? "Running..." : "Run"}
                </button>
              </div>
            </div>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-sidebar px-3 py-2.5 font-mono text-xs text-text-main">{curl}</pre>
          </div>

          {error ? <p className="break-words text-xs text-red-500">{error}</p> : null}

          <div>
            <div className="mb-1.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                Response {result ? <span className="font-normal normal-case">&#9889; {result.latencyMs}ms{result.connectionLabel ? ` | account: ${result.connectionLabel}` : ""}</span> : null}
              </span>
              {result ? (
                <button type="button" onClick={() => copyResult(resultJson)} className="inline-flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-primary">
                  <span className="material-symbols-outlined text-[14px]">{copiedResult ? "check" : "content_copy"}</span>
                  {copiedResult ? "Copied" : "Copy"}
                </button>
              ) : null}
            </div>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-sidebar px-3 py-2.5 font-mono text-xs text-text-main opacity-70">{resultJson}</pre>
          </div>
        </div>
      </Card>
    </div>
  );
}
