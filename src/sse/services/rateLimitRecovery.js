import { randomUUID } from "node:crypto";
import { getProviderConnections, updateProviderConnection } from "@/lib/db/repos/connectionsRepo.js";
import { RATE_LIMIT_RECOVERY_CONFIG as config } from "@/shared/constants/rateLimitRecovery.js";

const state = globalThis.__rateLimitRecovery ??= { interval: null, startup: null, running: false };

function quotaAvailable(quota) {
  if (quota?.unlimited === true) return true;
  for (const field of ["remainingPercentage", "remaining"]) {
    const value = quota?.[field];
    if (value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))) return Number(value) > 0;
  }
  if (Number(quota?.total) > 0 && quota?.used != null && Number.isFinite(Number(quota.used))) {
    return Number(quota.used) < Number(quota.total);
  }
  return null;
}

export function getQuotaRecoveryStatus(provider, model, usage) {
  if (!usage || usage.error || usage.message) return { available: null };
  let entries = Object.entries(usage.quotas || {});
  if (provider === "codex") {
    const prefix = model?.includes("review") ? "review_" : model?.includes("spark") ? "spark_" : null;
    entries = entries.filter(([key]) => prefix ? key.startsWith(prefix) : !/^(review|spark)_/.test(key));
  } else if (provider === "antigravity" && model) {
    const modelKey = model.replace(/-[0-9]+x[0-9]+$/, "");
    const family = model.startsWith("gemini") ? "gemini_" : /^(claude|gpt)/.test(model) ? "claude_gpt_" : null;
    const familyEntries = family ? entries.filter(([key]) => key.startsWith(family)) : [];
    if (usage.quotas?.[modelKey]) {
      entries = [[modelKey, usage.quotas[modelKey]], ...familyEntries];
    } else {
      entries = familyEntries;
    }
  }
  const known = entries.filter(([, quota]) => quotaAvailable(quota) !== null);
  const exhausted = known.filter(([, quota]) => quotaAvailable(quota) === false);
  return {
    available: exhausted.length ? false : known.length && known.length === entries.length ? true : null,
    retryAt: Math.max(0, ...exhausted.map(([, quota]) => Date.parse(quota.resetAt) || 0)),
    verified: true,
  };
}

async function checkQuota(connection) {
  const { getUsageForProvider, supportsUsageForProvider } = await import("open-sse/services/usage.js");
  if (!supportsUsageForProvider(connection.provider)) return { available: true, verified: false };
  if (connection.authType === "apikey" || connection.authType === "api_key") {
    const { USAGE_APIKEY_PROVIDERS } = await import("@/shared/constants/providers.js");
    if (!USAGE_APIKEY_PROVIDERS.includes(connection.provider)) return { available: true, verified: false };
  }
  const { resolveConnectionProxyConfig } = await import("@/lib/network/connectionProxy");
  const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
  const proxyOptions = {
    connectionProxyEnabled: proxy.connectionProxyEnabled === true,
    connectionProxyUrl: proxy.connectionProxyUrl || "",
    connectionNoProxy: proxy.connectionNoProxy || "",
    vercelRelayUrl: proxy.vercelRelayUrl || "",
    strictProxy: false,
  };
  if (connection.authType === "oauth") {
    const { refreshAndUpdateCredentials } = await import("@/app/api/usage/[connectionId]/route.js");
    ({ connection } = await refreshAndUpdateCredentials(connection, false, proxyOptions));
  }
  const usage = await getUsageForProvider(connection, proxyOptions, { force: true });
  return getQuotaRecoveryStatus(connection.provider, connection.rateLimitRecovery.model, usage);
}

export async function runRateLimitRecoveryTick(deps = {}, scheduler = state) {
  if (scheduler.running) return;
  scheduler.running = true;
  const load = deps.loadConnections || getProviderConnections;
  const update = deps.updateConnection || updateProviderConnection;
  const inspect = deps.checkQuota || checkQuota;
  try {
    const now = Date.now();
    const due = (await load({ isActive: false }))
      .filter((connection) => connection.isActive === false && Number(connection.errorCode) !== 401 &&
        !connection.antigravityValidationRequired && connection.rateLimitRecovery?.id &&
        Date.parse(connection.rateLimitRecovery.nextCheckAt) <= now)
      .sort((first, second) => Date.parse(first.rateLimitRecovery.nextCheckAt) - Date.parse(second.rateLimitRecovery.nextCheckAt))
      .slice(0, config.batchSize);

    for (const connection of due) {
      let timer;
      let claimed;
      try {
        const recovery = connection.rateLimitRecovery;
        const lockUntil = Math.max(0, ...Object.entries(connection)
          .filter(([key]) => key.startsWith("modelLock_"))
          .map(([, value]) => Date.parse(value) || 0));
        if (lockUntil > Date.now()) {
          await update(connection.id, { rateLimitRecovery: { ...recovery, nextCheckAt: new Date(lockUntil).toISOString() } }, { expectedRecoveryId: recovery.id });
          continue;
        }
        claimed = await update(connection.id, {
          rateLimitRecovery: {
            ...recovery,
            id: randomUUID(),
            nextCheckAt: new Date(Date.now() + config.checkTimeoutMs + config.tickIntervalMs).toISOString(),
          },
        }, { expectedRecoveryId: recovery.id });
        if (!claimed) continue;

        const result = await Promise.race([
          inspect(claimed),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Quota recovery check timed out")), config.checkTimeoutMs); }),
        ]);
        if (result?.available === true) {
          const cleared = Object.fromEntries(Object.keys(claimed)
            .filter((key) => /^(modelLock_|modelError_|modelErrorCode_)/.test(key))
            .map((key) => [key, null]));
          await update(claimed.id, {
            ...cleared,
            isActive: true,
            rateLimitRecovery: null,
            testStatus: result.verified === false ? "untested" : "active",
            lastError: null,
            lastErrorAt: null,
            errorCode: null,
            rateLimitedUntil: null,
            backoffLevel: result.verified === false ? claimed.backoffLevel || 0 : 0,
          }, { expectedRecoveryId: claimed.rateLimitRecovery.id });
        } else {
          await deferRecovery(claimed, update, result?.retryAt);
        }
      } catch (error) {
        console.warn("[429 Recovery]", connection.id, error.message);
        if (claimed) await deferRecovery(claimed, update).catch(() => {});
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    console.warn("[429 Recovery] Tick failed:", error.message);
  } finally {
    scheduler.running = false;
  }
}

async function deferRecovery(connection, update, retryAt = 0) {
  const recovery = connection.rateLimitRecovery;
  const attempts = Math.min((Number(recovery.attempts) || 0) + 1, 10);
  const delay = Math.min(config.retryDelayMs * 2 ** (attempts - 1), config.maxRetryDelayMs);
  await update(connection.id, {
    rateLimitRecovery: { ...recovery, attempts, nextCheckAt: new Date(Math.max(Date.now() + delay, retryAt || 0)).toISOString() },
  }, { expectedRecoveryId: recovery.id });
}

export function startRateLimitRecovery() {
  if (state.interval || process.env.NEXT_PHASE === "phase-production-build" || process.env.NEXT_RUNTIME === "edge") return;
  const tick = () => { runRateLimitRecoveryTick().catch(() => {}); };
  state.startup = setTimeout(tick, config.startupDelayMs);
  state.interval = setInterval(tick, config.tickIntervalMs);
  state.startup.unref?.();
  state.interval.unref?.();
}

export function stopRateLimitRecovery() {
  clearTimeout(state.startup);
  clearInterval(state.interval);
  state.startup = null;
  state.interval = null;
}
