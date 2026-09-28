import { afterEach, beforeEach, expect, it, vi } from "vitest";

const start = vi.hoisted(() => vi.fn());
vi.mock("@/lib/consoleLogBuffer", () => ({ initConsoleLogCapture: vi.fn() }));
vi.mock("open-sse/providers/catalogOverride.js", () => ({ installCatalogSource: vi.fn() }));
vi.mock("@/lib/modelCatalog/sync.js", () => ({ startModelCatalogSync: vi.fn() }));
vi.mock("@/sse/services/rateLimitRecovery.js", () => ({ startRateLimitRecovery: start }));

import { register } from "../../src/instrumentation.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NEXT_PHASE", "phase-production-server");
});

afterEach(() => vi.unstubAllEnvs());

it("starts recovery at Node server startup without a dashboard request", async () => {
  await register();
  expect(start).toHaveBeenCalledOnce();
});

it("does not start recovery while prerendering a build", async () => {
  vi.stubEnv("NEXT_PHASE", "phase-production-build");
  await register();
  expect(start).not.toHaveBeenCalled();
});

it("does not load the recovery scheduler in the Edge runtime", async () => {
  vi.stubEnv("NEXT_RUNTIME", "edge");
  await register();
  expect(start).not.toHaveBeenCalled();
});
