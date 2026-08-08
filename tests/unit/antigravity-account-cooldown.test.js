import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
  shouldNotifyAccountError: vi.fn(),
  notifyAccountError: vi.fn(),
  getUsageForProvider: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  validateApiKey: mocks.validateApiKey,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: mocks.pickProxyPoolId,
}));

vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: (provider) => provider,
  FREE_PROVIDERS: {},
}));

vi.mock("../../src/sse/services/quotaNotifier.js", () => ({
  shouldNotifyAccountError: mocks.shouldNotifyAccountError,
  notifyAccountError: mocks.notifyAccountError,
  summarizeQuotaPercent: (usage) => usage?.summary || "unknown",
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
}));

vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { getProviderCredentials, markAccountUnavailable } = await import("../../src/sse/services/auth.js");

function account(id, priority, lockUntil = null) {
  return {
    id,
    provider: "antigravity",
    email: `${id}@example.com`,
    priority,
    isActive: true,
    accessToken: `${id}-token`,
    providerSpecificData: {},
    ...(lockUntil ? { "modelLock_gemini-3.1-flash-image": lockUntil } : {}),
  };
}

describe("Antigravity account cooldown selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
    mocks.resolveConnectionProxyConfig.mockResolvedValue({
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      proxyPoolId: null,
      vercelRelayUrl: "",
    });
    mocks.shouldNotifyAccountError.mockReturnValue(true);
    mocks.notifyAccountError.mockResolvedValue({ sent: true });
    mocks.getUsageForProvider.mockResolvedValue({ summary: "73% (session)" });
  });

  it("does not call a rate-limited account again until its model reset time", async () => {
    const locked = account("limited", 1, new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString());
    const fallback = account("ready", 2);
    mocks.getProviderConnections.mockResolvedValue([locked, fallback]);

    const credentials = await getProviderCredentials(
      "antigravity",
      new Set(),
      "gemini-3.1-flash-image"
    );

    expect(credentials.connectionId).toBe("ready");
    expect(credentials.accessToken).toBe("ready-token");
  });

  it("demotes an account with any active quota lock when the caller has no model", async () => {
    const locked = account("limited", 1, new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString());
    const fallback = account("ready", 2);
    mocks.getProviderConnections.mockResolvedValue([locked, fallback]);

    const credentials = await getProviderCredentials("antigravity");

    expect(credentials.connectionId).toBe("ready");
  });

  it("returns the account to the pool automatically after the reset time", async () => {
    const resetPassed = account("limited", 1, new Date(Date.now() - 1000).toISOString());
    const fallback = account("ready", 2);
    mocks.getProviderConnections.mockResolvedValue([resetPassed, fallback]);

    const credentials = await getProviderCredentials(
      "antigravity",
      new Set(),
      "gemini-3.1-flash-image"
    );

    expect(credentials.connectionId).toBe("limited");
  });

  it("stores the provider reset timestamp exactly even when it is more than 24 hours away", async () => {
    const connection = account("limited", 1);
    const resetAtMs = Date.now() + 3 * 24 * 60 * 60 * 1000;
    mocks.getProviderConnections.mockResolvedValue([connection]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await markAccountUnavailable(
      connection.id,
      429,
      "RESOURCE_EXHAUSTED",
      "antigravity",
      "gemini-3.1-flash-image",
      resetAtMs
    );

    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "limited",
      expect.objectContaining({
        "modelLock_gemini-3.1-flash-image": new Date(resetAtMs).toISOString(),
      })
    );
    await vi.waitFor(() => expect(mocks.notifyAccountError).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "limited",
      provider: "antigravity",
      model: "gemini-3.1-flash-image",
      resetAt: new Date(resetAtMs).toISOString(),
      remainingAccounts: [],
    })));
  });

  it("lists only active accounts that are still usable", async () => {
    const failed = account("failed", 1);
    const ready = account("ready", 2);
    const disabled = { ...account("disabled", 3), isActive: false };
    const locked = account("locked", 4, new Date(Date.now() + 60_000).toISOString());
    mocks.getProviderConnections.mockResolvedValue([failed, ready, disabled, locked]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await markAccountUnavailable(
      failed.id,
      500,
      "upstream failed",
      "antigravity",
      "gemini-3.1-flash-image"
    );

    await vi.waitFor(() => expect(mocks.notifyAccountError).toHaveBeenCalledWith(expect.objectContaining({
      remainingAccounts: [{
        id: "ready",
        provider: "antigravity",
        name: "ready@example.com",
        quotaSummary: "73% (session)",
        hasError: false,
      }],
    })));
  });
});
