import { NextResponse } from "next/server";
import { exportDb, getSettings, importDb } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver";
import { backupDbLite, makeBackupDir, pruneOldBackups } from "@/lib/db/backup";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const PASSWORD_HEADER = "x-9r-password";

// CLI token requests are already trusted (local machine); skip password re-auth.
function isCliRequest(request) {
  return Boolean(request.headers.get(CLI_TOKEN_HEADER));
}

function validateEditorPayload(payload) {
  const arrays = ["providerConnections", "providerNodes", "proxyPools", "apiKeys", "combos", "customModels"];
  const objects = ["settings", "modelAliases", "mitmAlias", "disabledModels", "pricing"];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Database JSON must be an object");
  }
  for (const key of arrays) {
    if (!Array.isArray(payload[key])) throw new Error(`${key} must be an array`);
  }
  for (const key of objects) {
    if (!payload[key] || typeof payload[key] !== "object" || Array.isArray(payload[key])) {
      throw new Error(`${key} must be an object`);
    }
  }
}

export async function GET(request) {
  try {
    if (!isCliRequest(request) && !(await verifyDashboardPassword(request.headers.get(PASSWORD_HEADER)))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    const payload = await exportDb();
    return NextResponse.json(payload);
  } catch (error) {
    console.log("Error exporting database:", error);
    return NextResponse.json({ error: "Failed to export database" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { password, database, ...legacyPayload } = body;
    if (!isCliRequest(request) && !(await verifyDashboardPassword(password))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    const payload = database === undefined ? legacyPayload : database;
    if (database !== undefined) validateEditorPayload(payload);

    const backupDir = makeBackupDir("before-database-import");
    backupDbLite(await getAdapter(), backupDir);
    pruneOldBackups();
    await importDb(payload);

    // Ensure proxy settings take effect immediately after a DB import.
    try {
      const settings = await getSettings();
      applyOutboundProxyEnv(settings);
    } catch (err) {
      console.warn("[Settings][DatabaseImport] Failed to re-apply outbound proxy env:", err);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error importing database:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to import database" },
      { status: 400 }
    );
  }
}
