import { describe, it, expect, vi, afterEach } from "vitest";
import { extractCodexImageQuota, handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";

describe("Codex imagegen_premium quota tracking & 429 resetsAtMs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts imagegen_premium quota from OpenAI response headers", () => {
    const response = new Response("{}", {
      status: 429,
      headers: {
        "x-codex-active-limit": "imagegen_premium",
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-window-minutes": "1440",
        "x-codex-primary-reset-at": "1795502043",
        "x-codex-primary-reset-after-seconds": "14578",
      },
    });

    const quota = extractCodexImageQuota(response);
    expect(quota).toMatchObject({
      activeLimit: "imagegen_premium",
      used: 100,
      total: 100,
      remaining: 0,
      resetAt: new Date(1795502043 * 1000).toISOString(),
      windowMinutes: 1440,
    });
  });

  it("ignores non-image active limits", () => {
    const response = new Response("{}", {
      status: 200,
      headers: {
        "x-codex-active-limit": "codex",
        "x-codex-primary-used-percent": "20",
      },
    });

    expect(extractCodexImageQuota(response)).toBeNull();
  });

  it("forwards imageQuota via onImageQuota and extracts resetsAtMs on 429 usage_limit_reached", async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 14400;
    const mockResp = new Response(JSON.stringify({
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        plan_type: "pro",
        resets_at: resetSec,
        limit_window_minutes: 1440,
        resets_in_seconds: 14400,
      },
    }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "x-codex-active-limit": "imagegen_premium",
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-window-minutes": "1440",
        "x-codex-primary-reset-at": String(resetSec),
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResp);
    const onImageQuota = vi.fn();

    const result = await handleImageGenerationCore({
      body: { prompt: "a red apple", size: "1024x1024" },
      modelInfo: { provider: "codex", model: "gpt-image-2.5" },
      credentials: { accessToken: "fake-token", providerSpecificData: { chatgptPlanType: "pro" } },
      onImageQuota,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
    expect(result.resetsAtMs).toBe(resetSec * 1000);
    expect(onImageQuota).toHaveBeenCalledTimes(1);
    expect(onImageQuota).toHaveBeenCalledWith(expect.objectContaining({
      activeLimit: "imagegen_premium",
      used: 100,
      remaining: 0,
      windowMinutes: 1440,
      resetAt: new Date(resetSec * 1000).toISOString(),
    }));
  });
});
