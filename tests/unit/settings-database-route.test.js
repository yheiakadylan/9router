import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exportDb: vi.fn(),
  getSettings: vi.fn(),
  importDb: vi.fn(),
  getAdapter: vi.fn(),
  backupDbLite: vi.fn(),
  makeBackupDir: vi.fn(() => "backup-dir"),
  pruneOldBackups: vi.fn(),
  applyOutboundProxyEnv: vi.fn(),
  verifyDashboardPassword: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ body, status: init?.status || 200 }),
  },
}));

vi.mock("@/lib/localDb", () => ({
  exportDb: mocks.exportDb,
  getSettings: mocks.getSettings,
  importDb: mocks.importDb,
}));

vi.mock("@/lib/db/driver", () => ({ getAdapter: mocks.getAdapter }));
vi.mock("@/lib/db/backup", () => ({
  backupDbLite: mocks.backupDbLite,
  makeBackupDir: mocks.makeBackupDir,
  pruneOldBackups: mocks.pruneOldBackups,
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: mocks.applyOutboundProxyEnv }));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardPassword: mocks.verifyDashboardPassword }));

const { POST } = await import("../../src/app/api/settings/database/route.js");

const database = {
  settings: {},
  providerConnections: [],
  providerNodes: [],
  proxyPools: [],
  apiKeys: [],
  combos: [],
  modelAliases: {},
  customModels: [],
  mitmAlias: {},
  disabledModels: {},
  pricing: {},
};

function request(body) {
  return {
    headers: new Headers(),
    json: vi.fn().mockResolvedValue(body),
  };
}

describe("settings database editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyDashboardPassword.mockResolvedValue(true);
    mocks.getAdapter.mockResolvedValue({ driver: "test" });
    mocks.getSettings.mockResolvedValue({});
  });

  it("backs up and imports a validated editor payload", async () => {
    const response = await POST(request({ password: "secret", database }));

    expect(response.status).toBe(200);
    expect(mocks.importDb).toHaveBeenCalledWith(database);
    expect(mocks.backupDbLite).toHaveBeenCalledWith({ driver: "test" }, "backup-dir");
    expect(mocks.backupDbLite.mock.invocationCallOrder[0]).toBeLessThan(mocks.importDb.mock.invocationCallOrder[0]);
  });

  it("rejects malformed editor JSON before touching the database", async () => {
    const response = await POST(request({ password: "secret", database: { settings: {} } }));

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("providerConnections must be an array");
    expect(mocks.backupDbLite).not.toHaveBeenCalled();
    expect(mocks.importDb).not.toHaveBeenCalled();
  });

  it("keeps the existing flat backup import format compatible", async () => {
    const response = await POST(request({ password: "secret", ...database }));

    expect(response.status).toBe(200);
    expect(mocks.importDb).toHaveBeenCalledWith(database);
  });
});
