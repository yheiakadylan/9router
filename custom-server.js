const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { fork } = require("child_process");
const { pathToFileURL } = require("url");

const origCreate = http.createServer.bind(http);

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

let backgroundRefreshStarted = false;

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  server.once("listening", () => {
    const role = process.env.NINEROUTER_WORKER_ROLE;
    if (role !== "proxy" && role !== "api") {
      startBackgroundTokenRefreshFromCustomServer();
    }
  });
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

function isApiRequestPath(requestUrl = "") {
  const pathname = String(requestUrl).split("?", 1)[0];
  return /^\/(?:api\/)?v1(?:beta)?(?:\/|$)/.test(pathname)
    || /^\/(?:responses|codex|systemone)(?:\/|$)/.test(pathname);
}

function getConfiguredPort(fallback) {
  if (process.env.PORT) return Number(process.env.PORT) || fallback;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--port" || arg === "-p") return Number(args[index + 1]) || fallback;
    if (arg.startsWith("--port=")) return Number(arg.slice("--port=".length)) || fallback;
  }
  return fallback;
}

function startNextServer() {
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
    return;
  }

  // Repo checkout has no standalone build next to us. `next start` builds its HTTP
  // server in-process, so the wrapper above still sanitizes every request.
  const nextBin = require.resolve("next/dist/bin/next");
  const args = process.argv.slice(2).filter((arg, index, all) => {
    if (arg === "--port" || arg === "-p") return false;
    if (index > 0 && (all[index - 1] === "--port" || all[index - 1] === "-p")) return false;
    return !arg.startsWith("--port=");
  });
  process.argv = [process.argv[0], nextBin, "start", ...args, "--port", String(getConfiguredPort(3000))];
  require(nextBin);
}

function proxyRequest(req, res, targetPort) {
  const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` };
  delete headers["x-9r-peer-token"];

  const upstream = http.request({
    hostname: "127.0.0.1",
    port: targetPort,
    method: req.method,
    path: req.url,
    headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "1" });
      res.end(JSON.stringify({ error: "Worker unavailable", detail: error.message }));
    } else {
      res.destroy(error);
    }
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

function startWorkerRouter(numApiWorkers) {
  const publicPort = getConfiguredPort(20128);
  const internalBasePort = Number(process.env.INTERNAL_WORKER_BASE_PORT) || publicPort + 1000;
  const workerSpecs = [
    { key: "control", role: "control", port: internalBasePort },
    ...Array.from({ length: numApiWorkers }, (_, index) => ({
      key: `api-${index + 1}`,
      role: "api",
      port: internalBasePort + index + 1,
    })),
  ];
  const workers = new Map();
  let shuttingDown = false;
  let apiIndex = 0;

  const spawnWorker = (spec) => {
    const child = fork(__filename, process.argv.slice(2), {
      env: {
        ...process.env,
        PORT: String(spec.port),
        HOSTNAME: "127.0.0.1",
        NINEROUTER_WORKER_ROLE: spec.role,
      },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    workers.set(spec.key, child);
    child.on("message", (message) => {
      if (!String(message?.type || "").startsWith("ninerouter:usage-")) return;
      const control = workers.get("control");
      if (control && control !== child && control.connected) control.send(message);
    });
    child.once("exit", (code, signal) => {
      workers.delete(spec.key);
      if (shuttingDown) {
        if (workers.size === 0) process.exit(0);
        return;
      }
      console.warn(`[Router] ${spec.key} exited (${signal || code}). Respawning...`);
      setTimeout(() => spawnWorker(spec), 1000);
    });
  };

  for (const spec of workerSpecs) spawnWorker(spec);

  process.env.NINEROUTER_WORKER_ROLE = "proxy";
  const apiSpecs = workerSpecs.filter((spec) => spec.role === "api");
  const server = http.createServer((req, res) => {
    const spec = isApiRequestPath(req.url)
      ? apiSpecs[apiIndex++ % apiSpecs.length]
      : workerSpecs[0];
    proxyRequest(req, res, spec.port);
  });

  server.listen(publicPort, process.env.HOSTNAME || "0.0.0.0", () => {
    console.log(`[Router] Listening on ${publicPort}: 1 control + ${numApiWorkers} API workers`);
  });

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    for (const child of workers.values()) child.kill("SIGTERM");
    const forceExit = setTimeout(() => process.exit(0), 10_000);
    forceExit.unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (require.main === module) {
  const role = process.env.NINEROUTER_WORKER_ROLE;
  const rawWorkers = process.env.API_WORKERS || process.env.CLUSTER_WORKERS;
  const numApiWorkers = rawWorkers ? parseInt(rawWorkers, 10) : 1;

  if (!role && Number.isInteger(numApiWorkers) && numApiWorkers > 1) {
    startWorkerRouter(numApiWorkers);
  } else {
    startNextServer();
  }
}

module.exports = { isApiRequestPath, proxyRequest };
