// Cache for GeoIP lookups (IP -> location string)
const geoCache = new Map();

/**
 * Normalize IP address: converts IPv6 loopback (::1) and IPv4-mapped IPv6 (::ffff:x.x.x.x) to standard IPv4.
 * @param {string} ip
 * @returns {string}
 */
export function normalizeIp(ip) {
  if (!ip) return "127.0.0.1";
  let clean = String(ip).trim();
  if (clean.startsWith("::ffff:")) clean = clean.slice(7);
  if (clean === "::1" || clean === "localhost") return "127.0.0.1";
  return clean;
}

/**
 * Check if IP is localhost, private LAN, or public internet.
 * @param {string} ip
 * @returns {"localhost" | "private" | "public"}
 */
export function getIpType(ip) {
  const norm = normalizeIp(ip);
  if (norm === "127.0.0.1" || norm === "localhost" || norm === "::1") return "localhost";
  if (
    norm.startsWith("10.") ||
    norm.startsWith("192.168.") ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(norm) ||
    norm.startsWith("fc00:") ||
    norm.startsWith("fe80:")
  ) {
    return "private";
  }
  return "public";
}

/**
 * Get human-readable location description for an IP.
 * @param {string} ip
 * @returns {string}
 */
export function getLocation(ip) {
  const type = getIpType(ip);
  if (type === "localhost") return "Máy nội bộ (Localhost)";
  if (type === "private") return "Mạng nội bộ (LAN)";

  const clean = normalizeIp(ip);
  if (geoCache.has(clean)) {
    return geoCache.get(clean);
  }

  // Trigger background lookup for public IP without blocking
  resolveGeoLocation(clean);

  return "Internet";
}

/**
 * Resolve public IP geolocation asynchronously with caching
 * @param {string} ip
 */
async function resolveGeoLocation(ip) {
  if (geoCache.has(ip)) return geoCache.get(ip);
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,city,regionName`, {
      signal: AbortSignal.timeout(2000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data.status === "success") {
        const loc = data.city ? `${data.city}, ${data.country}` : data.country;
        geoCache.set(ip, loc);
        return loc;
      }
    }
  } catch {}
  geoCache.set(ip, "Internet (Công cộng)");
  return "Internet (Công cộng)";
}

/**
 * Parse User-Agent string and clientTool into human-readable device, OS and application.
 * @param {string} userAgent
 * @param {string|null} clientTool
 * @returns {{ app: string, os: string, deviceLabel: string }}
 */
export function parseDevice(userAgent = "", clientTool = null) {
  const ua = String(userAgent || "");
  const uaLower = ua.toLowerCase();

  // 1. OS Detection
  let os = "Không rõ OS";
  if (uaLower.includes("windows")) {
    if (uaLower.includes("10.0.22") || uaLower.includes("10.0.26") || uaLower.includes("windows 11")) {
      os = "Windows 11";
    } else if (uaLower.includes("windows nt 10.0") || uaLower.includes("windows 10")) {
      os = "Windows 10";
    } else {
      os = "Windows";
    }
  } else if (uaLower.includes("macintosh") || uaLower.includes("mac os x") || uaLower.includes("darwin")) {
    os = "macOS";
  } else if (uaLower.includes("android")) {
    os = "Android";
  } else if (uaLower.includes("iphone") || uaLower.includes("ipad") || uaLower.includes("ios")) {
    os = "iOS";
  } else if (uaLower.includes("linux")) {
    os = "Linux";
  }

  // 2. Application / Client Tool Detection
  const isVikcom = clientTool === "vikcom-intelligence" || clientTool === "vikcom" || uaLower.includes("vikcom");
  let app = clientTool ? (isVikcom ? "VIKCOM Intelligence" : clientTool.toUpperCase()) : "Client API";
  if (isVikcom) {
    let browser = "";
    if (uaLower.includes("edg")) browser = "Edge";
    else if (uaLower.includes("chrome")) browser = "Chrome";
    else if (uaLower.includes("firefox")) browser = "Firefox";
    else if (uaLower.includes("safari") && !uaLower.includes("chrome")) browser = "Safari";
    app = browser ? `VIKCOM Intelligence (${browser})` : "VIKCOM Intelligence";
  } else if (uaLower.includes("antigravity ide") || uaLower.includes("antigravity")) {
    app = "Antigravity IDE";
  } else if (uaLower.includes("codex_vscode") || (uaLower.includes("codex") && uaLower.includes("vscode"))) {
    app = "Codex (VS Code)";
  } else if (uaLower.includes("codex-cli") || uaLower.includes("codex-tui")) {
    app = "Codex CLI";
  } else if (uaLower.includes("claude-code") || uaLower.includes("claude-cli")) {
    app = "Claude Code";
  } else if (uaLower.includes("cursor")) {
    app = "Cursor";
  } else if (uaLower.includes("windsurf")) {
    app = "Windsurf";
  } else if (uaLower.includes("githubcopilot")) {
    app = "GitHub Copilot";
  } else if (uaLower.includes("chrome") && !uaLower.includes("edg")) {
    app = "Chrome";
  } else if (uaLower.includes("edg")) {
    app = "Edge";
  } else if (uaLower.includes("firefox")) {
    app = "Firefox";
  } else if (uaLower.includes("curl")) {
    app = "cURL";
  } else if (uaLower.includes("python")) {
    app = "Python";
  } else if (uaLower.includes("postman")) {
    app = "Postman";
  }

  let deviceLabel = "";
  if (app && os !== "Không rõ OS") {
    deviceLabel = `${app} · ${os}`;
  } else if (app) {
    deviceLabel = app;
  } else {
    deviceLabel = os;
  }

  return { app, os, deviceLabel };
}
