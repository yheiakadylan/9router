import { afterEach, describe, expect, it, vi } from "vitest";

const httpMocks = vi.hoisted(() => ({ createServer: vi.fn() }));

vi.mock("http", () => ({
  default: { createServer: httpMocks.createServer },
}));

const fakeServer = {
  close: vi.fn(),
  listen: vi.fn((port, host, callback) => callback()),
  on: vi.fn(),
};

httpMocks.createServer.mockReturnValue(fakeServer);

const { startCodexProxy, stopCodexProxy } = await import("../../src/lib/oauth/utils/server.js");

afterEach(() => {
  stopCodexProxy();
  vi.clearAllMocks();
  httpMocks.createServer.mockReturnValue(fakeServer);
});

describe("Codex OAuth callback listener", () => {
  it("binds the same localhost host used by the registered redirect URI", async () => {
    await startCodexProxy(20127);

    expect(fakeServer.listen).toHaveBeenCalledWith(1455, "localhost", expect.any(Function));
  });
});
