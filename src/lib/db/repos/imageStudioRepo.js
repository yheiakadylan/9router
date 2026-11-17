import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../../dataDir.js";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

export const IMAGE_STUDIO_TTL_MS = 24 * 60 * 60 * 1000;
export const IMAGE_STUDIO_MAX_CONVERSATIONS = 20;
export const IMAGE_STUDIO_MAX_ASSET_BYTES = 20 * 1024 * 1024;

const ASSET_DIR = path.join(DATA_DIR, "image-studio");
const MIME_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function nextExpiry(now = Date.now()) {
  return new Date(now + IMAGE_STUDIO_TTL_MS).toISOString();
}

function conversationFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    textModel: row.textModel,
    imageModel: row.imageModel,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    ...parseJson(row.data, {}),
  };
}

function assetFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    mimeType: row.mimeType,
    fileName: row.fileName,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    url: `/api/image-studio/assets/${encodeURIComponent(row.id)}`,
  };
}

function withoutDataImages(value) {
  if (Array.isArray(value)) return value.map(withoutDataImages);
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.startsWith("data:image/") ? "" : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutDataImages(item)]));
}

async function removeFiles(fileNames) {
  await Promise.all(fileNames.map((fileName) => unlink(path.join(ASSET_DIR, fileName)).catch(() => {})));
}

export async function cleanupImageStudio() {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const expired = db.all(`SELECT id FROM imageStudioConversations WHERE expiresAt <= ?`, [now]).map((row) => row.id);
  const overflow = db.all(
    `SELECT id FROM imageStudioConversations WHERE expiresAt > ? ORDER BY updatedAt DESC LIMIT -1 OFFSET ?`,
    [now, IMAGE_STUDIO_MAX_CONVERSATIONS]
  ).map((row) => row.id);
  const conversationIds = [...new Set([...expired, ...overflow])];
  const orphanAssets = db.all(`SELECT id, fileName FROM imageStudioAssets WHERE expiresAt <= ?`, [now]);
  const fileNames = orphanAssets.map((row) => row.fileName);

  db.transaction(() => {
    if (conversationIds.length > 0) {
      const placeholders = conversationIds.map(() => "?").join(",");
      fileNames.push(...db.all(
        `SELECT fileName FROM imageStudioAssets WHERE conversationId IN (${placeholders})`,
        conversationIds
      ).map((row) => row.fileName));
      db.run(`DELETE FROM imageStudioAssets WHERE conversationId IN (${placeholders})`, conversationIds);
      db.run(`DELETE FROM imageStudioConversations WHERE id IN (${placeholders})`, conversationIds);
    }
    if (orphanAssets.length > 0) {
      const ids = orphanAssets.map((row) => row.id);
      db.run(`DELETE FROM imageStudioAssets WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    }
  });

  await removeFiles([...new Set(fileNames)]);
  return conversationIds.length + orphanAssets.length;
}

export async function listImageStudioConversations({ recoverInterrupted = false, activeConversationIds = [] } = {}) {
  await cleanupImageStudio();
  const db = await getAdapter();
  if (recoverInterrupted) {
    const activeIds = new Set(activeConversationIds);
    const generating = db.all(`SELECT id FROM imageStudioConversations WHERE status = 'generating'`).map((row) => row.id);
    const interrupted = generating.filter((id) => !activeIds.has(id));
    if (interrupted.length > 0) {
      const placeholders = interrupted.map(() => "?").join(",");
      db.run(
        `UPDATE imageStudioConversations SET status = 'error', updatedAt = ? WHERE id IN (${placeholders})`,
        [new Date().toISOString(), ...interrupted]
      );
    }
  }
  return db.all(
    `SELECT * FROM imageStudioConversations ORDER BY updatedAt DESC LIMIT ?`,
    [IMAGE_STUDIO_MAX_CONVERSATIONS]
  ).map(conversationFromRow);
}

export async function createImageStudioConversation({ title = "New image chat", textModel = null, imageModel = null } = {}) {
  await cleanupImageStudio();
  const db = await getAdapter();
  const now = new Date().toISOString();
  const conversation = {
    id: randomUUID(),
    title: String(title || "New image chat").slice(0, 100),
    status: "idle",
    textModel,
    imageModel,
    messages: [],
    createdAt: now,
    updatedAt: now,
    expiresAt: nextExpiry(),
  };
  db.run(
    `INSERT INTO imageStudioConversations(id, title, status, textModel, imageModel, data, createdAt, updatedAt, expiresAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [conversation.id, conversation.title, conversation.status, textModel, imageModel, stringifyJson({ messages: [] }), now, now, conversation.expiresAt]
  );
  await cleanupImageStudio();
  return conversation;
}

export async function getImageStudioConversation(id) {
  await cleanupImageStudio();
  const db = await getAdapter();
  return conversationFromRow(db.get(`SELECT * FROM imageStudioConversations WHERE id = ?`, [id]));
}

export async function updateImageStudioConversation(id, patch = {}) {
  await cleanupImageStudio();
  const db = await getAdapter();
  const existing = conversationFromRow(db.get(`SELECT * FROM imageStudioConversations WHERE id = ?`, [id]));
  if (!existing) return null;
  const now = new Date().toISOString();
  const messages = Array.isArray(patch.messages) ? withoutDataImages(patch.messages).slice(-100) : existing.messages || [];
  const title = patch.title === undefined ? existing.title : String(patch.title || "New image chat").slice(0, 100);
  const status = ["idle", "generating", "success", "error"].includes(patch.status) ? patch.status : existing.status;
  const textModel = patch.textModel === undefined ? existing.textModel : patch.textModel;
  const imageModel = patch.imageModel === undefined ? existing.imageModel : patch.imageModel;
  const expiresAt = nextExpiry();
  db.run(
    `UPDATE imageStudioConversations SET title = ?, status = ?, textModel = ?, imageModel = ?, data = ?, updatedAt = ?, expiresAt = ? WHERE id = ?`,
    [title, status, textModel, imageModel, stringifyJson({ messages }), now, expiresAt, id]
  );
  db.run(`UPDATE imageStudioAssets SET expiresAt = ? WHERE conversationId = ?`, [expiresAt, id]);
  return { ...existing, title, status, textModel, imageModel, messages, updatedAt: now, expiresAt };
}

export async function deleteImageStudioConversation(id) {
  const db = await getAdapter();
  const assets = db.all(`SELECT fileName FROM imageStudioAssets WHERE conversationId = ?`, [id]);
  let deleted = false;
  db.transaction(() => {
    db.run(`DELETE FROM imageStudioAssets WHERE conversationId = ?`, [id]);
    const result = db.run(`DELETE FROM imageStudioConversations WHERE id = ?`, [id]);
    deleted = Number(result?.changes || 0) > 0;
  });
  await removeFiles(assets.map((asset) => asset.fileName));
  return deleted;
}

export async function saveImageStudioAsset({ conversationId, bytes, mimeType }) {
  await cleanupImageStudio();
  const extension = MIME_EXTENSIONS[mimeType];
  if (!extension) throw new Error("Unsupported image type");
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!buffer.length || buffer.length > IMAGE_STUDIO_MAX_ASSET_BYTES) throw new Error("Image must be between 1 byte and 20 MB");
  if (!(await getImageStudioConversation(conversationId))) throw new Error("Conversation not found");

  await mkdir(ASSET_DIR, { recursive: true });
  const id = randomUUID();
  const fileName = `${id}.${extension}`;
  await writeFile(path.join(ASSET_DIR, fileName), buffer);
  const db = await getAdapter();
  const now = new Date().toISOString();
  const expiresAt = nextExpiry();
  db.run(
    `INSERT INTO imageStudioAssets(id, conversationId, mimeType, fileName, createdAt, expiresAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [id, conversationId, mimeType, fileName, now, expiresAt]
  );
  return assetFromRow({ id, conversationId, mimeType, fileName, createdAt: now, expiresAt });
}

export async function getImageStudioAsset(id) {
  await cleanupImageStudio();
  const db = await getAdapter();
  const asset = assetFromRow(db.get(`SELECT * FROM imageStudioAssets WHERE id = ?`, [id]));
  if (!asset) return null;
  try {
    return { ...asset, bytes: await readFile(path.join(ASSET_DIR, asset.fileName)) };
  } catch {
    db.run(`DELETE FROM imageStudioAssets WHERE id = ?`, [id]);
    return null;
  }
}

export async function getImageStudioAssetDataUrl(id) {
  const asset = await getImageStudioAsset(id);
  return asset ? `data:${asset.mimeType};base64,${asset.bytes.toString("base64")}` : null;
}
