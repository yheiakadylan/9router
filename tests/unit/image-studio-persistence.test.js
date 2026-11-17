import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-image-studio-"));
process.env.DATA_DIR = tempDir;

let repo;
let getAdapter;

beforeAll(async () => {
  repo = await import("../../src/lib/db/repos/imageStudioRepo.js");
  ({ getAdapter } = await import("../../src/lib/db/driver.js"));
});

afterAll(async () => {
  (await getAdapter()).close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Image Studio persistence", () => {
  it("stores image bytes on disk and keeps base64 out of conversation JSON", async () => {
    const conversation = await repo.createImageStudioConversation();
    const asset = await repo.saveImageStudioAsset({
      conversationId: conversation.id,
      mimeType: "image/png",
      bytes: Buffer.from([137, 80, 78, 71]),
    });

    await repo.updateImageStudioConversation(conversation.id, {
      status: "success",
      messages: [{ role: "assistant", images: [{ src: asset.url }, { src: "data:image/png;base64,AAAA" }] }],
    });

    const saved = await repo.getImageStudioConversation(conversation.id);
    const loadedAsset = await repo.getImageStudioAsset(asset.id);
    expect(saved.messages[0].images).toEqual([{ src: asset.url }, { src: "" }]);
    expect(loadedAsset.bytes).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it("keeps only the 20 most recently updated conversations", async () => {
    for (let index = 0; index < 21; index += 1) {
      await repo.createImageStudioConversation({ title: `Chat ${index}` });
    }
    const conversations = await repo.listImageStudioConversations();
    expect(conversations).toHaveLength(20);
  });

  it("removes expired conversations and their files", async () => {
    const conversation = await repo.createImageStudioConversation({ title: "Expired" });
    const asset = await repo.saveImageStudioAsset({
      conversationId: conversation.id,
      mimeType: "image/png",
      bytes: Buffer.from([1, 2, 3]),
    });
    const db = await getAdapter();
    db.run(`UPDATE imageStudioConversations SET expiresAt = ? WHERE id = ?`, ["2000-01-01T00:00:00.000Z", conversation.id]);
    await repo.cleanupImageStudio();

    expect(await repo.getImageStudioConversation(conversation.id)).toBeNull();
    expect(await repo.getImageStudioAsset(asset.id)).toBeNull();
  });

  it("keeps active jobs generating across a page reload and marks only orphaned jobs interrupted", async () => {
    const active = await repo.createImageStudioConversation({ title: "Active" });
    const orphaned = await repo.createImageStudioConversation({ title: "Orphaned" });
    await repo.updateImageStudioConversation(active.id, { status: "generating" });
    await repo.updateImageStudioConversation(orphaned.id, { status: "generating" });

    const conversations = await repo.listImageStudioConversations({
      recoverInterrupted: true,
      activeConversationIds: [active.id],
    });
    const statuses = Object.fromEntries(conversations.map((conversation) => [conversation.id, conversation.status]));

    expect(statuses[active.id]).toBe("generating");
    expect(statuses[orphaned.id]).toBe("error");
  });
});
