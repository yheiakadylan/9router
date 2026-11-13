import { afterEach, describe, expect, it, vi } from "vitest";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { getExecutor } from "../../open-sse/executors/index.js";

const imageModels = [
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
];
const image = { created: 123, data: [{ b64_json: "aW1hZ2U=" }] };
const credentials = {
  accessToken: "test-oauth-token",
  apiKey: "unused-platform-key",
  providerSpecificData: { chatgptAccountId: "test-account" },
};
const jsonResponse = (data = image) => Response.json(data);
const request = (overrides = {}) => ({
  modelInfo: { provider: "codex", model: "gpt-image-2.5" },
  body: { prompt: "A cute cat wearing a hat", output_format: "PNG" },
  credentials: structuredClone(credentials),
  ...overrides,
});
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("native Codex OAuth image generation", () => {
  it.each(imageModels)("generates %s using existing OAuth credentials without a Responses tool", async (model) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      ...image,
      usage: { input_tokens: 15, output_tokens: 515, total_tokens: 530 },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onUsage = vi.fn();
    const onRequestSuccess = vi.fn();
    const result = await handleImageGenerationCore(request({
      modelInfo: { provider: "codex", model },
      onUsage,
      onRequestSuccess,
    }));

    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual(image);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(options.headers.authorization).toBe("Bearer test-oauth-token");
    expect(options.headers["chatgpt-account-id"]).toBe("test-account");
    expect(options.headers.accept).toBe("application/json");
    const upstream = JSON.parse(options.body);
    expect(upstream).toMatchObject({ model, prompt: "A cute cat wearing a hat" });
    expect(upstream).not.toHaveProperty("tools");
    expect(upstream).not.toHaveProperty("reasoning");
    expect(upstream).not.toHaveProperty("complexity");
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ prompt_tokens: 15, completion_tokens: 515, total_tokens: 530 });
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });

  it("converts native JSON to the client's existing done SSE contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse()));
    const onRequestSuccess = vi.fn();
    const onUsage = vi.fn();
    const result = await handleImageGenerationCore(request({ streamToClient: true, onRequestSuccess, onUsage }));
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe("text/event-stream");
    expect(await result.response.text()).toBe(sse("done", image));
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("edits reference images through the native endpoint without inheriting response complexity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleImageGenerationCore(request({
      modelInfo: { provider: "codex", model: "gpt-image-2.5-flare" },
      body: {
        prompt: "Add a red hat",
        images: ["data:image/png;base64,cmVm"],
        size: "1024x1024",
        quality: "auto",
        complexity: "medium",
      },
    }));

    expect(result.success).toBe(true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    const upstream = JSON.parse(options.body);
    expect(upstream).toEqual({
      images: [{ image_url: "data:image/png;base64,cmVm" }],
      prompt: "Add a red hat",
      model: "gpt-image-2.5-flare",
      size: "1024x1024",
    });
    expect(upstream).not.toHaveProperty("reasoning");
    expect(upstream).not.toHaveProperty("complexity");
  });

  it("maps legacy chat-image models to the native image model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleImageGenerationCore(request({
      modelInfo: { provider: "codex", model: "gpt-6-sol-image" },
      body: { prompt: "Edit this image", image: "data:image/png;base64,cmVm" },
    }));

    expect(result.success).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("gpt-image-2");
  });

  it("retains binary image output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse()));
    const result = await handleImageGenerationCore(request({ binaryOutput: true }));
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await result.response.arrayBuffer()).toString()).toBe("image");
  });

  it("refreshes OAuth and retries the same native endpoint after HTTP 401", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { message: "Expired token" } }, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(getExecutor("codex"), "refreshCredentials").mockResolvedValue({ accessToken: "refreshed-oauth-token" });
    const onCredentialsRefreshed = vi.fn();
    const result = await handleImageGenerationCore(request({ onCredentialsRefreshed }));
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(options.headers.authorization).toBe("Bearer refreshed-oauth-token");
    expect(JSON.parse(options.body).model).toBe("gpt-image-2.5");
    expect(onCredentialsRefreshed).toHaveBeenCalledExactlyOnceWith({ accessToken: "refreshed-oauth-token" });
  });

  it("rejects missing native image output without inventing an entitlement error or usage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [] })));
    const onUsage = vi.fn();
    const onRequestSuccess = vi.fn();
    const result = await handleImageGenerationCore(request({ onUsage, onRequestSuccess }));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(await result.response.text()).toContain("Codex Images API returned no image.");
    expect(onUsage).not.toHaveBeenCalled();
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("reports invalid native JSON clearly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("invalid JSON")));
    const result = await handleImageGenerationCore(request());
    expect(result.success).toBe(false);
    expect(await result.response.text()).toContain("Codex Images API returned invalid JSON.");
  });
});

describe("legacy Codex image Responses compatibility", () => {
  it("returns safety rejections as non-retryable bad requests", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sse("response.failed", {
      response: {
        error: {
          message: "Your request was rejected by the safety system. safety_violations=[sexual].",
        },
      },
    }), { headers: { "content-type": "text/event-stream" } })));

    const result = await handleImageGenerationCore(request({
      modelInfo: { provider: "codex", model: "gpt-6-sol" },
      body: { prompt: "Create an image" },
    }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.retryable).toBe(false);
    expect(await result.response.text()).toContain("rejected by the safety system");
  });

  it("parses an SSE event split across network chunks", async () => {
    const encoder = new TextEncoder();
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("event: response.output_item.done\n"));
        controller.enqueue(encoder.encode('data: {"item":{"type":"image_generation_call","result":"aW1hZ2U="}}'));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    })));

    const result = await handleImageGenerationCore(request({
      modelInfo: { provider: "codex", model: "gpt-6-sol" },
      body: { prompt: "Create an image" },
    }));

    expect(result.success).toBe(true);
    expect((await result.response.json()).data).toEqual(image.data);
  });

  it.each(["error", "response.failed"])("preserves the observed %s instead of guessing a paid plan is missing", async (event) => {
    const error = { type: "image_generation_user_error", code: "invalid_value", message: "Complexity 'medium' is not supported for this image model.", param: "complexity" };
    const data = event === "error" ? { error } : { response: { error } };
    let cancelled = false;
    const upstream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(sse(event, data))); },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(upstream, { headers: { "content-type": "text/event-stream" } })));
    const onRequestSuccess = vi.fn();
    const result = await handleImageGenerationCore(request({
      modelInfo: { provider: "codex", model: "gpt-6-sol" },
      body: { prompt: "Create an image" },
      streamToClient: true,
      onRequestSuccess,
    }));
    const output = await result.response.text();
    expect(output).toContain(sse("error", { message: error.message, code: error.code, type: error.type, param: error.param }));
    expect(output).not.toContain("paid ChatGPT plan required");
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
  });

  it("accepts a final image included only in response.completed output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sse("response.completed", {
      response: { output: [{ type: "image_generation_call", result: "aW1hZ2U=" }] },
    }))));
    const result = await handleImageGenerationCore(request({ modelInfo: { provider: "codex", model: "gpt-6-sol" } }));
    expect(result.success).toBe(true);
    expect((await result.response.json()).data).toEqual(image.data);
  });

  const hostRejected = () => Response.json({
    detail: "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.",
    error: { type: "invalid_request_error", code: "model_not_found" },
  }, { status: 400 });
  const imageStream = () => new Response(
    sse("response.output_item.done", { item: { type: "image_generation_call", result: "aW1hZ2U=" } }),
    { headers: { "content-type": "text/event-stream" } },
  );

  it("retries once on the fallback host model when the account rejects gpt-6-sol", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(hostRejected()).mockResolvedValueOnce(imageStream());
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleImageGenerationCore(request({ body: { prompt: "cat", size: "1024x1024", partial_images: 1 } }));
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(first.model).toBe("gpt-6-sol");
    expect(second.model).toBe("gpt-5.6-terra");
    expect(second.tools[0].model).toBe("gpt-image-2.5");
  });

  it("does not swap the host of a *-image model requested by name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(hostRejected());
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleImageGenerationCore(request({ modelInfo: { provider: "codex", model: "gpt-6-sol-image" } }));
    expect(result.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry other upstream 400s", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ detail: "Invalid size." }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleImageGenerationCore(request({ body: { prompt: "cat", size: "1024x1024", partial_images: 1 } }));
    expect(result.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
