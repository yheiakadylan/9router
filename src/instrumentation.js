export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    if (process.env.NINEROUTER_WORKER_ROLE !== "api") {
      const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
      startModelCatalogSync();

      if (process.env.NEXT_PHASE !== "phase-production-build") {
        const { startRateLimitRecovery } = await import("@/sse/services/rateLimitRecovery.js");
        startRateLimitRecovery();
      }
    }
  }
}
