import { describe, expect, it } from "vitest";
import codexAdapter from "../../open-sse/handlers/imageProviders/codex.js";

function makeMockSseResponse(events) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const { event, data } of events) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

describe("Codex stream error handling", () => {
  it("captures exact error message from event: error", async () => {
    const mockRes = makeMockSseResponse([
      { event: "response.created", data: { response: { status: "in_progress" } } },
      {
        event: "error",
        data: {
          type: "error",
          error: {
            code: "server_is_overloaded",
            message: "Our servers are currently overloaded. Please try again later.",
          },
        },
      },
    ]);

    await expect(codexAdapter.parseResponse(mockRes, { log: null })).rejects.toThrow(
      "Our servers are currently overloaded. Please try again later."
    );
  });

  it("captures exact error message from response.failed", async () => {
    const mockRes = makeMockSseResponse([
      {
        event: "response.failed",
        data: {
          response: {
            status: "failed",
            error: {
              code: "rate_limit_exceeded",
              message: "You have reached your hourly image limit.",
            },
          },
        },
      },
    ]);

    await expect(codexAdapter.parseResponse(mockRes, { log: null })).rejects.toThrow(
      "You have reached your hourly image limit."
    );
  });

  it("captures assistant text when model refuses and returns text message", async () => {
    const mockRes = makeMockSseResponse([
      {
        event: "response.output_item.done",
        data: {
          item: {
            type: "message",
            status: "completed",
            content: [{ type: "output_text", text: "I cannot generate images of real people." }],
          },
        },
      },
    ]);

    await expect(codexAdapter.parseResponse(mockRes, { log: null })).rejects.toThrow(
      'Codex returned text instead of an image: "I cannot generate images of real people."'
    );
  });

  it("successfully parses valid image base64", async () => {
    const mockRes = makeMockSseResponse([
      {
        event: "response.output_item.done",
        data: {
          item: {
            type: "image_generation_call",
            status: "completed",
            result: "valid_base64_image_data",
          },
        },
      },
    ]);

    const result = await codexAdapter.parseResponse(mockRes, { log: null });
    expect(result.data[0].b64_json).toBe("valid_base64_image_data");
  });
});
