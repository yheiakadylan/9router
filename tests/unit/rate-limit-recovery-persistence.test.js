import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

let tempDir;
let adapter;
let connections;
const originalAdapter = global._dbAdapter;

async function openDatabase() {
  vi.resetModules();
  delete global._dbAdapter;
  const { getAdapter } = await import("../../src/lib/db/driver.js");
  adapter = await getAdapter();
  connections = await import("../../src/lib/db/repos/connectionsRepo.js");
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-recovery-"));
  vi.stubEnv("DATA_DIR", tempDir);
  await openDatabase();
});

afterAll(() => {
  adapter?.close();
  global._dbAdapter = originalAdapter;
  vi.unstubAllEnvs();
  if (tempDir && path.dirname(path.resolve(tempDir)) === path.resolve(os.tmpdir())) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it("retains a scheduled 429 recovery across closing and reopening SQLite", async () => {
  const created = await connections.createProviderConnection({ provider: "codex", authType: "oauth", name: "recovery-test", accessToken: "test-only" });
  const recovery = { id: "persisted-recovery", model: "gpt-5.5-image", nextCheckAt: new Date(Date.now() + 60000).toISOString(), attempts: 2 };
  await connections.updateProviderConnection(created.id, { isActive: false, errorCode: 429, rateLimitRecovery: recovery });
  adapter.close();
  await openDatabase();

  expect(await connections.getProviderConnectionById(created.id)).toMatchObject({ isActive: false, errorCode: 429, rateLimitRecovery: recovery });
  await connections.updateProviderConnection(created.id, { isActive: false });
  expect(await connections.updateProviderConnection(created.id, { isActive: true }, { expectedRecoveryId: recovery.id })).toBeNull();
  expect(await connections.getProviderConnectionById(created.id)).toMatchObject({ isActive: false, rateLimitRecovery: null });
});
