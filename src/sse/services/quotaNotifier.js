const LARK_WEBHOOK_HOST = "open.larksuite.com";
const LARK_WEBHOOK_PATH = "/open-apis/bot/v2/hook/";
const DEFAULT_LARK_WEBHOOK_URL = "https://open.larksuite.com/open-apis/bot/v2/hook/aa4d1473-3e3f-4a4c-babe-25e4ac4028a5";
const DEFAULT_DEDUPE_MS = 5 * 60_000;
const INVALID_REQUEST_STATUSES = new Set([400, 404, 405, 406, 415, 422]);

const state = globalThis.__quotaLarkNotifierState ??= { sentUntil: new Map() };

function getWebhookUrl() {
  const raw = process.env.LARK_QUOTA_WEBHOOK_URL?.trim() || DEFAULT_LARK_WEBHOOK_URL;
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== LARK_WEBHOOK_HOST || !url.pathname.startsWith(LARK_WEBHOOK_PATH)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function shouldNotifyAccountError({ status }) {
  return !INVALID_REQUEST_STATUSES.has(Number(status));
}

function quotaPercentage(quota) {
  const toNumber = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return null;
  };
  const remainingPercentage = toNumber(quota?.remainingPercentage);
  if (Number.isFinite(remainingPercentage)) return Math.max(0, Math.min(100, Math.round(remainingPercentage)));

  const total = toNumber(quota?.total);
  if (!Number.isFinite(total) || total <= 0) return null;
  const remaining = toNumber(quota?.remaining);
  if (Number.isFinite(remaining)) return Math.max(0, Math.min(100, Math.round((remaining / total) * 100)));
  const used = toNumber(quota?.used);
  if (!Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.round(((total - used) / total) * 100)));
}

export function summarizeQuotaPercent(usage, provider, model = null) {
  let entries = Object.entries(usage?.quotas || {});
  if (provider === "codex") entries = entries.filter(([name]) => !name.startsWith("review_"));
  if (provider === "antigravity" && model && usage?.quotas?.[model]) entries = [[model, usage.quotas[model]]];

  const quotas = entries
    .map(([name, quota]) => ({ name, percentage: quotaPercentage(quota) }))
    .filter(({ percentage }) => percentage !== null)
    .sort((a, b) => a.percentage - b.percentage);
  return quotas.length > 0 ? `${quotas[0].percentage}% (${quotas[0].name})` : "unknown";
}

export function shouldDisplayRemainingAccount(account) {
  const percentage = String(account?.quotaSummary || "").match(/^(\d+)%/);
  if (percentage) return Number(percentage[1]) > 0;
  return account?.hasError !== true;
}

function formatReset(resetAt) {
  if (!resetAt) return "unknown";
  const resetMs = new Date(resetAt).getTime();
  if (!Number.isFinite(resetMs)) return String(resetAt);
  const minutes = Math.max(0, Math.ceil((resetMs - Date.now()) / 60_000));
  return `${new Date(resetMs).toISOString()} (${minutes}m)`;
}

export async function notifyAccountError({
  connectionId,
  accountName,
  provider,
  model,
  status,
  errorText,
  resetAt,
  cooldownMs = 0,
  remainingAccounts = [],
}) {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) return { sent: false, reason: "disabled" };

  const now = Date.now();
  const resetMs = resetAt ? new Date(resetAt).getTime() : NaN;
  const dedupeUntil = now + Math.max(
    DEFAULT_DEDUPE_MS,
    cooldownMs,
    Number.isFinite(resetMs) ? resetMs - now : 0
  );
  const dedupeKey = connectionId;
  if ((state.sentUntil.get(dedupeKey) || 0) > now) {
    return { sent: false, reason: "deduped" };
  }

  // ponytail: per-process dedupe is enough for the local single-server runtime.
  state.sentUntil.set(dedupeKey, dedupeUntil);

  const visibleAccounts = remainingAccounts.filter(shouldDisplayRemainingAccount);
  const usableAccounts = visibleAccounts.length > 0
    ? visibleAccounts.map((account) => (
      `- ${account.provider || "unknown"} / ${account.name || account.id} | quota: ${account.quotaSummary || "unknown"}`
    )).join("\n")
    : "- none";
  const heading = visibleAccounts.length === 0
    ? "CRITICAL: No active usable account remains"
    : "WARNING: Provider account unavailable";
  const text = [
    heading,
    `Provider: ${provider || "unknown"}`,
    `Account: ${accountName || connectionId}`,
    `Model: ${model || "all"}`,
    `Status: ${status || "unknown"}`,
    `Reset: ${formatReset(resetAt)}`,
    `Active usable accounts (${visibleAccounts.length}):`,
    usableAccounts,
    `Error: ${String(errorText || "Provider error").slice(0, 240)}`,
  ].join("\n");

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text } }),
      signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(5_000)
        : undefined,
    });
    const result = await response.json().catch(() => ({}));
    const larkError = (result.code !== undefined && result.code !== 0)
      || (result.StatusCode !== undefined && result.StatusCode !== 0);
    if (!response.ok || larkError) {
      throw new Error(`Lark webhook rejected notification (${response.status})`);
    }
    return { sent: true };
  } catch (error) {
    state.sentUntil.delete(dedupeKey);
    throw error;
  }
}
