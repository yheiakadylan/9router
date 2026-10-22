const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("keeps control traffic stateful and balances inference traffic", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-router-"));
  fs.copyFileSync(path.join(__dirname, "..", "..", "custom-server.js"), path.join(tempDir, "custom-server.js"));
  fs.writeFileSync(path.join(tempDir, "server.js"), `
    const http = require("http");
    let usageEvents = 0;
    process.on("message", (message) => {
      if (message?.type === "ninerouter:usage-probe") usageEvents++;
    });
    http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (process.env.NINEROUTER_WORKER_ROLE === "api") {
        process.send?.({ type: "ninerouter:usage-probe" });
      }
      res.end(JSON.stringify({
        role: process.env.NINEROUTER_WORKER_ROLE,
        pid: process.pid,
        url: req.url,
        usageEvents,
      }));
    }).listen(Number(process.env.PORT), process.env.HOSTNAME);
  `);

  const publicPort = 24000 + Math.floor(Math.random() * 1000);
  const internalBasePort = publicPort + 2000;
  const router = spawn(process.execPath, [path.join(tempDir, "custom-server.js")], {
    env: {
      ...process.env,
      PORT: String(publicPort),
      HOSTNAME: "127.0.0.1",
      INTERNAL_WORKER_BASE_PORT: String(internalBasePort),
      API_WORKERS: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  router.stdout.on("data", (chunk) => { output += chunk; });
  router.stderr.on("data", (chunk) => { output += chunk; });

  async function getJson(url) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${publicPort}${url}`);
        if (response.ok) return response.json();
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`router did not become ready\n${output}`);
  }

  try {
    const firstControl = await getJson("/api/auth/login");
    const secondControl = await getJson("/api/mcp/playwright/sse");
    assert.equal(firstControl.role, "control");
    assert.equal(secondControl.pid, firstControl.pid);

    const firstApi = await getJson("/v1/chat/completions");
    const secondApi = await getJson("/api/v1/responses");
    assert.equal(firstApi.role, "api");
    assert.equal(secondApi.role, "api");
    assert.notEqual(firstApi.pid, secondApi.pid);

    const ipcDeadline = Date.now() + 2000;
    let controlState;
    while (Date.now() < ipcDeadline) {
      controlState = await getJson("/ipc-count");
      if (controlState.usageEvents >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(controlState.usageEvents, 2);
  } finally {
    router.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      router.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
