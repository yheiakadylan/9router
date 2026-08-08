import { describe, expect, it } from "vitest";
import { getAverageImageDurationMs } from "../../src/shared/utils/imageUsage.js";

describe("image usage average duration", () => {
  it("ignores non-image requests", () => {
    const average = getAverageImageDurationMs([
      { endpoint: "/v1/images/generations", model: "gpt-5.5-image", durationMs: 80_000 },
      { endpoint: "/v1/chat/completions", model: "gpt-5.5", durationMs: 2_000 },
      { model: "flux-schnell", latency: { total: 40_000 } },
    ]);

    expect(average).toBe(60_000);
  });
});
