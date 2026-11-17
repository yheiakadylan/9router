import { beforeEach, describe, expect, it, vi } from "vitest";

const updateConversation = vi.fn(async (_id, patch) => patch);
const saveAsset = vi.fn(async () => ({ url: "/api/image-studio/assets/generated" }));
const handleChat = vi.fn();
const handleImageGeneration = vi.fn();

vi.mock("@/lib/db", () => ({
  getImageStudioAssetDataUrl: vi.fn(async () => null),
  saveImageStudioAsset: saveAsset,
  updateImageStudioConversation: updateConversation,
}));

vi.mock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn(async () => {}) }));

vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat,
}));

vi.mock("@/sse/handlers/imageGeneration.js", () => ({
  handleImageGeneration,
}));

describe("Image Studio server jobs", () => {
  beforeEach(() => {
    updateConversation.mockClear();
    saveAsset.mockClear();
    handleChat.mockReset();
    handleChat.mockResolvedValue(Response.json({
      choices: [{
        message: {
          content: "I will create it.",
          tool_calls: [{ function: { name: "generate_image", arguments: JSON.stringify({ prompt: "A red fox" }) } }],
        },
      }],
    }));
    handleImageGeneration.mockReset();
    handleImageGeneration.mockResolvedValue(Response.json({ data: [{ b64_json: "iVBORw0KGgo=" }] }));
  });

  it("keeps a job in the server registry and persists its final image", async () => {
    const { getActiveImageStudioJobs, startImageStudioJob } = await import("../../src/lib/imageStudioJobs.js");
    const assistantId = "assistant-1";
    const jobId = await startImageStudioJob({
      conversationId: "conversation-1",
      assistantId,
      title: "Fox",
      textModel: "cx/text",
      imageModel: "cx/image",
      messages: [
        { id: "user-1", role: "user", content: "Draw a fox", references: [] },
        { id: assistantId, role: "assistant", content: "", images: [], phase: "thinking" },
      ],
      userPrompt: "Draw a fox",
      userReferences: [],
    });

    expect(getActiveImageStudioJobs()).toContainEqual({ id: jobId, conversationId: "conversation-1" });
    await vi.waitFor(() => expect(getActiveImageStudioJobs()).toHaveLength(0));

    const finalPatch = updateConversation.mock.calls.at(-1)[1];
    expect(finalPatch.status).toBe("success");
    expect(finalPatch.messages[1].images[0]).toMatchObject({
      status: "done",
      src: "/api/image-studio/assets/generated",
    });
    expect(saveAsset).toHaveBeenCalledOnce();
  });

  it("removes a job from the registry when its initial save fails", async () => {
    const { getActiveImageStudioJobs, startImageStudioJob } = await import("../../src/lib/imageStudioJobs.js");
    updateConversation.mockRejectedValueOnce(new Error("database is locked"));

    await expect(startImageStudioJob({
      conversationId: "conversation-2",
      assistantId: "assistant-2",
      textModel: "cx/text",
      imageModel: "cx/image",
      messages: [],
    })).rejects.toThrow("database is locked");

    expect(getActiveImageStudioJobs()).toHaveLength(0);
  });

  it("reports a missing conversation without leaving a stale job", async () => {
    const { getActiveImageStudioJobs, startImageStudioJob } = await import("../../src/lib/imageStudioJobs.js");
    updateConversation.mockResolvedValueOnce(null);

    await expect(startImageStudioJob({
      conversationId: "missing",
      assistantId: "assistant-3",
      textModel: "cx/text",
      imageModel: "cx/image",
      messages: [],
    })).rejects.toMatchObject({ message: "Conversation not found", status: 404 });

    expect(getActiveImageStudioJobs()).toHaveLength(0);
  });

  it("aborts the server request when a running job is stopped", async () => {
    const { cancelImageStudioJob, getActiveImageStudioJobs, startImageStudioJob } = await import("../../src/lib/imageStudioJobs.js");
    handleChat.mockImplementationOnce((request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));

    const jobId = await startImageStudioJob({
      conversationId: "conversation-4",
      assistantId: "assistant-4",
      textModel: "cx/text",
      imageModel: "cx/image",
      messages: [{ id: "assistant-4", role: "assistant", content: "", images: [], phase: "thinking" }],
    });

    expect(cancelImageStudioJob(jobId)).toBe(true);
    await vi.waitFor(() => expect(getActiveImageStudioJobs()).toHaveLength(0));
    expect(updateConversation.mock.calls.at(-1)[1].status).toBe("error");
  });

  it("downloads provider image URLs into the internal asset store", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      headers: { "Content-Type": "image/png" },
    }));
    handleImageGeneration.mockResolvedValueOnce(Response.json({ data: [{ url: "https://example.com/generated.png" }] }));
    const { getActiveImageStudioJobs, startImageStudioJob } = await import("../../src/lib/imageStudioJobs.js");

    try {
      await startImageStudioJob({
        conversationId: "conversation-5",
        assistantId: "assistant-5",
        textModel: "cx/text",
        imageModel: "cx/image",
        messages: [{ id: "assistant-5", role: "assistant", content: "", images: [], phase: "thinking" }],
        userPrompt: "Draw a fox",
        userReferences: [],
      });
      await vi.waitFor(() => expect(getActiveImageStudioJobs()).toHaveLength(0));

      expect(global.fetch).toHaveBeenCalledWith("https://example.com/generated.png", expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(saveAsset).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "image/png" }));
    } finally {
      global.fetch = originalFetch;
    }
  });
});
