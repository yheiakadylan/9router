import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const rows = new Map();
  return {
    rows,
    adapter: {
      transaction: (callback) => callback(),
      get: (_query, [id]) => rows.get(id),
      run: vi.fn((_query, values) => {
        const [id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt] = values;
        rows.set(id, { id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt });
      }),
    },
    getUsage: vi.fn(),
    supportsUsage: vi.fn(),
    refresh: vi.fn(),
    proxy: vi.fn(),
  };
});

vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => mocks.adapter }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: mocks.getUsage, supportsUsageForProvider: mocks.supportsUsage }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.proxy }));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({ refreshAndUpdateCredentials: mocks.refresh }));

import { getProviderConnectionById, updateProviderConnection } from "@/lib/db/repos/connectionsRepo.js";
import { getQuotaRecoveryStatus, runRateLimitRecoveryTick, startRateLimitRecovery, stopRateLimitRecovery } from "@/sse/services/rateLimitRecovery.js";
import { RATE_LIMIT_RECOVERY_CONFIG as config } from "@/shared/constants/rateLimitRecovery.js";

const now = Date.parse("2026-09-28T10:00:00Z");
const future = new Date(now + 3600000).toISOString();
const past = new Date(now - 1000).toISOString();

function seed(overrides = {}) {
  const { id = "account-1", provider = "codex", authType = "oauth", isActive = false, ...extra } = overrides;
  mocks.rows.set(id, {
    id, provider, authType, name: id, isActive: Number(isActive), updatedAt: past,
    data: JSON.stringify({
      accessToken: "old-token",
      errorCode: 429,
      testStatus: "unavailable",
      lastError: "quota exhausted",
      backoffLevel: 2,
      "modelLock_gpt-5.5-image": past,
      "modelError_gpt-5.5-image": "quota exhausted",
      rateLimitRecovery: { id: "recovery-1", model: "gpt-5.5-image", nextCheckAt: past, attempts: 0 },
      ...extra,
    }),
  });
}

const current = () => getProviderConnectionById("account-1");
const load = async () => Promise.all([...mocks.rows.keys()].map(getProviderConnectionById));
const tick = (checkQuota) => runRateLimitRecoveryTick({ loadConnections: load, ...(checkQuota ? { checkQuota } : {}) }, { running: false });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.rows.clear();
  vi.clearAllMocks();
  mocks.supportsUsage.mockReturnValue(true);
  mocks.getUsage.mockResolvedValue({ quotas: { session: { remainingPercentage: 50 } } });
  mocks.proxy.mockResolvedValue({ connectionProxyEnabled: false });
  mocks.refresh.mockImplementation(async (connection) => ({ connection: { ...connection, accessToken: "fresh-token" }, refreshed: true }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  seed();
});

afterEach(() => {
  stopRateLimitRecovery();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("quota recovery decisions", () => {
  it("does not mistake another Antigravity image model's quota for the exhausted model", () => {
    const usage = { quotas: { "gemini-3.1-flash-image": { remainingPercentage: 0, resetAt: future }, "claude-opus": { remainingPercentage: 100 } } };
    expect(getQuotaRecoveryStatus("antigravity", "gemini-3.1-flash-image", usage)).toMatchObject({ available: false, retryAt: Date.parse(future) });
    expect(getQuotaRecoveryStatus("antigravity", "gemini-3.1-flash-image-16x9", usage).available).toBe(false);
  });

  it("uses the Antigravity family summary when the model is absent", () => {
    expect(getQuotaRecoveryStatus("antigravity", "gemini-3.1-flash-image", { quotas: {
      gemini_weekly: { remainingPercentage: 0 }, claude_gpt_weekly: { remainingPercentage: 100 },
    } }).available).toBe(false);
  });

  it("ignores unrelated Codex review and spark pools for image models", () => {
    const usage = { quotas: { session: { used: 10, total: 100 }, weekly: { remainingPercentage: 30 }, review_weekly: { remaining: 0 }, spark_session: { remaining: 0 } } };
    expect(getQuotaRecoveryStatus("codex", "gpt-5.5-image", usage).available).toBe(true);
    expect(getQuotaRecoveryStatus("codex", "gpt-5.5-review", usage).available).toBe(false);
    expect(getQuotaRecoveryStatus("codex", "gpt-5.3-codex-spark", usage).available).toBe(false);
  });

  it("requires both session and weekly quota to be available", () => {
    expect(getQuotaRecoveryStatus("codex", "gpt-5.5-image", { quotas: { session: { remainingPercentage: 80 }, weekly: { remainingPercentage: 0, resetAt: future } } })).toMatchObject({ available: false, retryAt: Date.parse(future) });
  });

  it("does not recover on partial quota data or an exhausted Antigravity family", () => {
    expect(getQuotaRecoveryStatus("codex", "gpt-5.5-image", { quotas: { session: { remainingPercentage: 80 }, weekly: {} } }).available).toBeNull();
    expect(getQuotaRecoveryStatus("antigravity", "gemini-3.1-flash-image", { quotas: {
      "gemini-3.1-flash-image": { remainingPercentage: 100 }, gemini_weekly: { remainingPercentage: 0 },
    } }).available).toBe(false);
  });

  it.each([null, {}, { message: "Unauthorized" }, { error: "offline" }, { quotas: { session: {} } }])("fails closed on unavailable quota data: %j", (usage) => {
    expect(getQuotaRecoveryStatus("codex", "gpt-5.5-image", usage).available).toBeNull();
  });
});

describe("429 recovery worker", () => {
  it("refreshes credentials, checks live quota and reactivates a due 429 account", async () => {
    await tick();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.getUsage).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "fresh-token" }), expect.any(Object), { force: true });
    expect(await current()).toMatchObject({ isActive: true, errorCode: null, rateLimitRecovery: null, testStatus: "active", backoffLevel: 0, "modelLock_gpt-5.5-image": null, "modelError_gpt-5.5-image": null });
  });

  it.each([
    { errorCode: 401 },
    { isActive: true },
    { rateLimitRecovery: null },
    { antigravityValidationRequired: true },
    { rateLimitRecovery: { id: "later", nextCheckAt: future } },
  ])("never checks or reactivates an ineligible account: %j", async (overrides) => {
    seed(overrides);
    const inspect = vi.fn();
    await tick(inspect);
    expect(inspect).not.toHaveBeenCalled();
    expect(mocks.adapter.run).not.toHaveBeenCalled();
  });

  it("waits for other model locks before checking quota", async () => {
    seed({ modelLock_other: future });
    await tick();
    expect(mocks.getUsage).not.toHaveBeenCalled();
    expect(await current()).toMatchObject({ isActive: false, rateLimitRecovery: { nextCheckAt: future } });
  });

  it("persists the next quota reset and resumes from the DB after a restart", async () => {
    mocks.getUsage.mockResolvedValueOnce({ quotas: { session: { remainingPercentage: 0, resetAt: future } } });
    await tick();
    expect(await current()).toMatchObject({ isActive: false, rateLimitRecovery: { attempts: 1, nextCheckAt: future } });
    await tick();
    expect(mocks.getUsage).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.parse(future));
    await tick();
    expect((await current()).isActive).toBe(true);
  });

  it("backs off failed checks without enabling the account", async () => {
    const inspect = vi.fn().mockRejectedValue(new Error("network unavailable"));
    await tick(inspect);
    expect(await current()).toMatchObject({ isActive: false, rateLimitRecovery: { attempts: 1, nextCheckAt: new Date(now + config.retryDelayMs).toISOString() } });
    vi.setSystemTime(now + config.retryDelayMs);
    await tick(inspect);
    expect(await current()).toMatchObject({ isActive: false, rateLimitRecovery: { attempts: 2, nextCheckAt: new Date(now + 3 * config.retryDelayMs).toISOString() } });
  });

  it("times out a hanging check and continues with other accounts", async () => {
    seed({ id: "account-2" });
    const inspect = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue({ available: true });
    const pending = tick(inspect);
    await vi.advanceTimersByTimeAsync(config.checkTimeoutMs + 1);
    await pending;
    expect((await current()).isActive).toBe(false);
    expect((await getProviderConnectionById("account-2")).isActive).toBe(true);
  });

  it("uses cooldown-based retry for providers without a quota API, retaining backoff", async () => {
    mocks.supportsUsage.mockReturnValue(false);
    await tick();
    expect(mocks.getUsage).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(await current()).toMatchObject({ isActive: true, rateLimitRecovery: null, testStatus: "untested", backoffLevel: 2 });
  });

  it("does not require an OAuth-only quota endpoint for API-key connections", async () => {
    seed({ provider: "claude", authType: "apikey", accessToken: null, apiKey: "test-only" });
    await tick();
    expect(mocks.getUsage).not.toHaveBeenCalled();
    expect((await current()).isActive).toBe(true);
  });

  it("caps the retry delay after repeated failures", async () => {
    seed({ rateLimitRecovery: { id: "retry", model: "gpt-5.5-image", nextCheckAt: past, attempts: 9 } });
    await tick(async () => ({ available: null }));
    expect(await current()).toMatchObject({ isActive: false, rateLimitRecovery: { nextCheckAt: new Date(now + config.maxRetryDelayMs).toISOString() } });
  });

  it("resumes an abandoned worker claim after its persisted lease expires", async () => {
    const leaseEnd = now + config.checkTimeoutMs + config.tickIntervalMs;
    await updateProviderConnection("account-1", { rateLimitRecovery: { id: "abandoned", nextCheckAt: new Date(leaseEnd).toISOString(), model: "gpt-5.5-image" } }, { expectedRecoveryId: "recovery-1" });
    await tick();
    expect(mocks.getUsage).not.toHaveBeenCalled();
    vi.setSystemTime(leaseEnd);
    await tick();
    expect((await current()).isActive).toBe(true);
  });

  it("checks a bounded batch and leaves the remaining accounts for the next tick", async () => {
    for (let index = 2; index <= config.batchSize + 1; index++) seed({ id: "account-" + index });
    const inspect = vi.fn().mockResolvedValue({ available: true });
    await tick(inspect);
    expect(inspect).toHaveBeenCalledTimes(config.batchSize);
    await tick(inspect);
    expect(inspect).toHaveBeenCalledTimes(config.batchSize + 1);
  });

  it("skips overlapping ticks in the same process", async () => {
    const loadConnections = vi.fn();
    await runRateLimitRecoveryTick({ loadConnections }, { running: true });
    expect(loadConnections).not.toHaveBeenCalled();
  });

  it("does not overwrite a manual disable while checking quota", async () => {
    await tick(async () => {
      await updateProviderConnection("account-1", { isActive: false });
      return { available: true };
    });
    expect(await current()).toMatchObject({ isActive: false, rateLimitRecovery: null });
  });

  it("does not reactivate a connection that changes to 401 during the check", async () => {
    await tick(async () => {
      await updateProviderConnection("account-1", { errorCode: 401, isActive: false });
      return { available: true };
    });
    expect(await current()).toMatchObject({ isActive: false, errorCode: 401, rateLimitRecovery: null });
  });

  it("does not clear a newer 429 incident with a stale successful check", async () => {
    await tick(async () => {
      await updateProviderConnection("account-1", { errorCode: 429, isActive: false, rateLimitRecovery: { id: "newer", nextCheckAt: future } });
      return { available: true };
    });
    expect(await current()).toMatchObject({ isActive: false, rateLimitRecovery: { id: "newer" } });
  });

  it("does not erase a fresh model cooldown created during quota inspection", async () => {
    await tick(async () => {
      await updateProviderConnection("account-1", { modelLock_other: future, errorCode: 500 });
      return { available: true };
    });
    expect(await current()).toMatchObject({ isActive: false, modelLock_other: future, errorCode: 500 });
  });

  it("retains recovery when a successful in-flight sibling clears the display error", async () => {
    await updateProviderConnection("account-1", { testStatus: "active", lastError: null });
    expect(await current()).toMatchObject({ isActive: false, errorCode: null, rateLimitRecovery: { id: "recovery-1" } });
    await tick();
    expect((await current()).isActive).toBe(true);
  });
});

describe("recovery persistence and scheduler guards", () => {
  it("manual activation and deactivation cancel the scheduled recovery", async () => {
    await updateProviderConnection("account-1", { isActive: true });
    expect((await current()).rateLimitRecovery).toBeNull();
    seed();
    await updateProviderConnection("account-1", { isActive: false });
    expect((await current()).rateLimitRecovery).toBeNull();
  });

  it("does not enroll manually disabled accounts on a late 429 response", async () => {
    seed({ rateLimitRecovery: null });
    await updateProviderConnection("account-1", { isActive: false, errorCode: 429, rateLimitRecovery: { id: "late", nextCheckAt: future } });
    expect((await current()).rateLimitRecovery).toBeNull();
  });

  it("atomically claims a recovery once and rejects a second worker", async () => {
    const claim = { rateLimitRecovery: { id: "claim", nextCheckAt: future } };
    expect(await updateProviderConnection("account-1", claim, { expectedRecoveryId: "recovery-1" })).not.toBeNull();
    expect(await updateProviderConnection("account-1", claim, { expectedRecoveryId: "recovery-1" })).toBeNull();
  });

  it("preserves recovery metadata when credentials are refreshed", async () => {
    await updateProviderConnection("account-1", { accessToken: "refreshed" });
    expect((await current()).rateLimitRecovery.id).toBe("recovery-1");
  });

  it("starts only one interval and stops both startup and recurring timers", () => {
    startRateLimitRecovery();
    startRateLimitRecovery();
    expect(vi.getTimerCount()).toBe(2);
    stopRateLimitRecovery();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start during production builds", () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    startRateLimitRecovery();
    expect(vi.getTimerCount()).toBe(0);
  });
});
