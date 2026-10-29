const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

process.env.NINEROUTER_WORKER_ROLE = "api";
const { isApiRequestPath, proxyRequest } = require("../../custom-server.js");

test("routes inference endpoints to the API worker pool", () => {
  for (const url of [
    "/v1/chat/completions",
    "/v1beta/models/gemini:generateContent?key=test",
    "/api/v1/responses",
    "/responses",
    "/codex/session",
    "/systemone",
  ]) {
    assert.equal(isApiRequestPath(url), true, url);
  }
});

test("keeps stateful and dashboard endpoints on the control worker", () => {
  for (const url of [
    "/api/auth/login",
    "/api/mcp/playwright/sse",
    "/api/oauth/codex/generate-auth-url",
    "/api/usage/stream",
    "/dashboard",
    "/api/health",
  ]) {
    assert.equal(isApiRequestPath(url), false, url);
  }
});

test("proxies request bodies and streamed responses", async () => {
  const backend = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString("utf8"), "request-body");
    assert.equal(req.headers.host, `127.0.0.1:${backend.address().port}`);
    assert.equal(req.headers["x-9r-peer-token"], process.env.NINEROUTER_PEER_TOKEN);
    res.writeHead(201, { "Content-Type": "text/plain", "X-Worker": "api" });
    res.write("stream-");
    res.end("ok");
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));

  const frontend = http.createServer((req, res) => proxyRequest(req, res, backend.address().port));
  await new Promise((resolve) => frontend.listen(0, "127.0.0.1", resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${frontend.address().port}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-9r-peer-token": "forged" },
      body: "request-body",
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-worker"), "api");
    assert.equal(await response.text(), "stream-ok");
  } finally {
    await new Promise((resolve) => frontend.close(resolve));
    await new Promise((resolve) => backend.close(resolve));
  }
});

test("closes the upstream stream when the downstream client disconnects", async () => {
  let resolveUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => { resolveUpstreamClosed = resolve; });
  const backend = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: ready\n\n");
    res.once("close", resolveUpstreamClosed);
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));

  const frontend = http.createServer((req, res) => proxyRequest(req, res, backend.address().port));
  await new Promise((resolve) => frontend.listen(0, "127.0.0.1", resolve));

  const clientRequest = http.get(`http://127.0.0.1:${frontend.address().port}/api/usage/stream`);
  clientRequest.on("error", () => {});

  try {
    await new Promise((resolve, reject) => {
      clientRequest.once("response", (response) => {
        response.once("data", () => {
          response.destroy();
          resolve();
        });
      });
      clientRequest.once("error", reject);
    });

    await Promise.race([
      upstreamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("upstream stream remained open")), 2000)),
    ]);
  } finally {
    clientRequest.destroy();
    frontend.closeAllConnections?.();
    backend.closeAllConnections?.();
    await Promise.all([
      new Promise((resolve) => frontend.close(resolve)),
      new Promise((resolve) => backend.close(resolve)),
    ]);
  }
});
