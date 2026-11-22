/**
 * Detect CLI tool identity from request headers/body.
 * Used to determine if a request can be passed through losslessly.
 */

// Map of CLI tool identifiers to provider IDs they are "native" to
const NATIVE_PAIRS = {
  "claude": ["claude", "anthropic"],
  "gemini-cli": ["gemini-cli"],
  "antigravity": ["antigravity"],
  "codex": ["codex"],
};

/**
 * Detect which CLI tool is making the request.
 * Returns one of: "claude" | "gemini-cli" | "antigravity" | "codex" | null
 * @param {object} headers - Lowercase header key/value object
 * @param {object} body    - Parsed request body
 */
export function detectClientTool(headers = {}, body = {}) {
  const ua = (headers["user-agent"] || "").toLowerCase();
  const xApp = (headers["x-app"] || "").toLowerCase();
  const openaiIntent = (headers["openai-intent"] || "").toLowerCase();
  const initiator = (headers["x-initiator"] || headers["X-Initiator"] || "").toLowerCase();
  const originator = (headers["originator"] || "").toLowerCase();

  // Antigravity: detected via body field (not header)
  if (body.userAgent === "antigravity") return "antigravity";

  // GitHub Copilot / OAI compatible extension using Copilot chat headers
  if (ua.includes("githubcopilotchat") || openaiIntent === "conversation-panel" || initiator === "user") {
    return "github-copilot";
  }

  // Claude Code / Claude CLI
  if (ua.includes("claude-cli") || ua.includes("claude-code") || xApp === "cli") return "claude";

  // Gemini CLI
  if (ua.includes("gemini-cli")) return "gemini-cli";

  // Codex CLI/Desktop — codex-tui is the current Rust CLI, codex-cli/codex_cli_rs legacy;
  // Codex Desktop identifies via UA "Codex Desktop" or originator "codex_work_desktop"
  if (ua.includes("codex-tui") || ua.includes("codex-cli") || ua.includes("codex_cli_rs") ||
      ua.includes("codex desktop") || originator.startsWith("codex_")) return "codex";

  // DeepSeek TUI
  if (ua.includes("deepseek-tui")) return "deepseek-tui";

  return null;
}

/**
 * Extract client IP from incoming request or headers.
 * Resolves x-9r-real-ip (from custom-server.js), cf-connecting-ip, x-real-ip,
 * x-forwarded-for, request.ip, socket remoteAddress, falling back to 127.0.0.1.
 * @param {object|Request} request - NextRequest, Web Request, or object with headers
 */
export function extractClientIp(request) {
  if (!request) return "127.0.0.1";
  if (typeof request === "string") return request;
  if (request.ip && typeof request.ip === "string") return request.ip;

  const headers = request.headers;
  const getHeader = (key) => {
    if (!headers) return null;
    if (typeof headers.get === "function") return headers.get(key);
    return headers[key] || headers[key.toLowerCase()] || null;
  };

  const raw =
    getHeader("x-9r-real-ip") ||
    getHeader("cf-connecting-ip") ||
    getHeader("x-real-ip") ||
    (getHeader("x-forwarded-for") ? String(getHeader("x-forwarded-for")).split(",")[0].trim() : null) ||
    request.socket?.remoteAddress ||
    "127.0.0.1";

  let clean = raw || "127.0.0.1";
  if (typeof clean === "string") {
    clean = clean.trim();
    if (clean.startsWith("::ffff:")) clean = clean.slice(7);
    if (clean === "::1" || clean === "localhost") clean = "127.0.0.1";
  }
  return clean || "127.0.0.1";
}

/**
 * Check if this CLI tool + provider pair should be passed through losslessly.
 * @param {string|null} clientTool - Result of detectClientTool()
 * @param {string} provider        - Provider ID (e.g. "claude", "gemini-cli")
 */
export function isNativePassthrough(clientTool, provider) {
  if (!clientTool) return false;
  const nativeProviders = NATIVE_PAIRS[clientTool];
  if (!nativeProviders) return false;
  // Support anthropic-compatible-* variants
  const normalizedProvider = provider.startsWith("anthropic-compatible")
    ? "anthropic"
    : provider;
  return nativeProviders.includes(normalizedProvider);
}
