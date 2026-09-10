import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const SCOPE = "modelOrder";

function buildKey(providerAlias, kind = "llm") {
  return `${providerAlias || "default"}:${kind || "llm"}`;
}

export async function getModelOrder(providerAlias, kind = "llm") {
  if (!providerAlias) return [];
  const db = await getAdapter();
  const key = buildKey(providerAlias, kind);
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, key]);
  return row ? (parseJson(row.value, []) || []) : [];
}

export async function getAllModelOrders() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value, []);
  return out;
}

export async function setModelOrder(providerAlias, kind = "llm", order = []) {
  if (!providerAlias || !Array.isArray(order)) return;
  const db = await getAdapter();
  const key = buildKey(providerAlias, kind);
  db.transaction(() => {
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [SCOPE, key, stringifyJson(order)]
    );
  });
}

export async function resetModelOrder(providerAlias, kind = "llm") {
  if (!providerAlias) return;
  const db = await getAdapter();
  const key = buildKey(providerAlias, kind);
  db.transaction(() => {
    db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, key]);
  });
}
