import { describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/translator/concerns/image.js", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchImageAsBase64: vi.fn(async (url) => url.includes("missing")
    ? null
    : { url: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png" }),
}));

import codexAdapter from "../../open-sse/handlers/imageProviders/codex.js";

describe("Codex remote reference images", () => {
  it("inlines a remote image before sending it upstream", async () => {
    const body = await codexAdapter.buildBody("gpt-image-2", {
      prompt: "Edit this image",
      image: "https://example.com/reference.png",
    });

    expect(body.input[0].content).toContainEqual({
      type: "input_image",
      image_url: "data:image/png;base64,iVBORw0KGgo=",
      detail: "high",
    });
  });

  it("reports an unavailable reference URL before calling upstream", async () => {
    await expect(codexAdapter.buildBody("gpt-image-2", {
      prompt: "Edit this image",
      image: "https://example.com/missing.png",
    })).rejects.toThrow("URL is public and still available");
  });
});
