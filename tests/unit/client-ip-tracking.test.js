import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractClientIp } from "../../open-sse/utils/clientDetector.js";
import { normalizeIp, getLocation, parseDevice } from "../../src/lib/deviceDetector.js";

describe("Device & Location detection", () => {
  it("normalizes ::1 to 127.0.0.1", () => {
    expect(normalizeIp("::1")).toBe("127.0.0.1");
    expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIp("192.168.1.1")).toBe("192.168.1.1");
  });

  it("identifies localhost and LAN locations", () => {
    expect(getLocation("::1")).toBe("Máy nội bộ (Localhost)");
    expect(getLocation("127.0.0.1")).toBe("Máy nội bộ (Localhost)");
    expect(getLocation("192.168.1.50")).toBe("Mạng nội bộ (LAN)");
  });

  it("parses Antigravity IDE and Windows 11 user agent", () => {
    const ua = "codex_vscode/0.169.0-alpha.11.1 (Windows 10.0.26200; x86_64) unknown (Antigravity IDE; 26.1111.21308)";
    const res = parseDevice(ua, "codex");
    expect(res.app).toBe("Antigravity IDE");
    expect(res.os).toBe("Windows 11");
    expect(res.deviceLabel).toBe("Antigravity IDE · Windows 11");
  });
});

describe("extractClientIp", () => {
  it("extracts from x-9r-real-ip", () => {
    const req = { headers: { "x-9r-real-ip": "10.0.0.1" } };
    expect(extractClientIp(req)).toBe("10.0.0.1");
  });

  it("extracts from cf-connecting-ip", () => {
    const req = { headers: { "cf-connecting-ip": "103.21.244.2" } };
    expect(extractClientIp(req)).toBe("103.21.244.2");
  });

  it("extracts from x-real-ip", () => {
    const req = { headers: { "x-real-ip": "118.69.182.5" } };
    expect(extractClientIp(req)).toBe("118.69.182.5");
  });

  it("extracts first ip from x-forwarded-for", () => {
    const req = { headers: { "x-forwarded-for": "14.162.1.2, 10.0.0.1" } };
    expect(extractClientIp(req)).toBe("14.162.1.2");
  });

  it("cleans ipv4-mapped ipv6 address", () => {
    const req = { headers: { "x-real-ip": "::ffff:127.0.0.1" } };
    expect(extractClientIp(req)).toBe("127.0.0.1");
  });

  it("falls back to 127.0.0.1 when no headers", () => {
    expect(extractClientIp({})).toBe("127.0.0.1");
    expect(extractClientIp(null)).toBe("127.0.0.1");
  });
});

describe("Usage DB IP tracking", () => {
  let tempDir;
  let db;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ip-test-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
  });

  it("persists ip and clientTool into usage meta and outputs in getRecentLogs", async () => {
    await db.saveRequestUsage({
      provider: "codex",
      model: "gpt-5.6-sol",
      connectionId: "conn-12345678",
      apiKey: "sk-test",
      endpoint: "/v1/responses",
      tokens: { prompt_tokens: 100, completion_tokens: 50 },
      ip: "192.168.1.100",
      clientTool: "codex",
      status: "200 OK"
    });

    const logs = await db.getRecentLogs(10);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("192.168.1.100");
    expect(logs[0]).toContain("Mạng nội bộ (LAN)");
  });
});
