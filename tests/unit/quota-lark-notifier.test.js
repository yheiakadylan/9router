import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  notifyAccountError,
  shouldDisplayRemainingAccount,
  shouldNotifyAccountError,
  summarizeQuotaPercent,
} from "../../src/sse/services/quotaNotifier.js";

const originalFetch = global.fetch;
const originalWebhook = process.env.LARK_QUOTA_WEBHOOK_URL;

describe("Lark quota notifier", () => {
  beforeEach(() => {
    process.env.LARK_QUOTA_WEBHOOK_URL = "https://open.larksuite.com/open-apis/bot/v2/hook/test-hook";
    global.fetch = vi.fn().mockResolvedValue(Response.json({ code: 0 }));
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    if (originalWebhook === undefined) delete process.env.LARK_QUOTA_WEBHOOK_URL;
    else process.env.LARK_QUOTA_WEBHOOK_URL = originalWebhook;
    vi.restoreAllMocks();
  });

  it("sends one Lark message and deduplicates the same cooldown", async () => {
    const notification = {
      connectionId: "codex-lark-test",
      accountName: "codex@example.com",
      provider: "codex",
      model: "gpt-5.5-image",
      status: 429,
      errorText: "usage_limit_reached",
      resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      cooldownMs: 60 * 60 * 1000,
      remainingAccounts: [
        {
          id: "codex-ready",
          provider: "codex",
          name: "ready@example.com",
          quotaSummary: "42% (weekly)",
        },
        {
          id: "codex-empty",
          provider: "codex",
          name: "empty@example.com",
          quotaSummary: "0% (session)",
        },
      ],
    };

    expect(await notifyAccountError(notification)).toEqual({ sent: true });
    expect(await notifyAccountError(notification)).toEqual({ sent: false, reason: "deduped" });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const request = global.fetch.mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(body).toEqual(expect.objectContaining({ msg_type: "text" }));
    expect(body.content.text).toContain("codex@example.com");
    expect(body.content.text).toContain("Active usable accounts (1):");
    expect(body.content.text).toContain("codex / ready@example.com");
    expect(body.content.text).toContain("quota: 42% (weekly)");
    expect(body.content.text).not.toContain("empty@example.com");
  });

  it("deduplicates an account across models for at least five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T04:55:00.000Z"));
    const notification = {
      connectionId: "codex-account-dedupe-test",
      provider: "codex",
      status: 401,
      errorText: "token revoked",
      resetAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      cooldownMs: 2 * 60_000,
    };

    expect(await notifyAccountError({ ...notification, model: "gpt-image-2" })).toEqual({ sent: true });
    vi.advanceTimersByTime(3 * 60_000);
    expect(await notifyAccountError({ ...notification, model: "gpt-5.6-sol" })).toEqual({
      sent: false,
      reason: "deduped",
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the built-in webhook when no environment override exists", async () => {
    delete process.env.LARK_QUOTA_WEBHOOK_URL;

    expect(await notifyAccountError({
      connectionId: "built-in-webhook-test",
      provider: "codex",
      status: 500,
      errorText: "upstream failed",
    })).toEqual({ sent: true });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toMatch(/^https:\/\/open\.larksuite\.com\/open-apis\/bot\/v2\/hook\//);
  });

  it("ignores invalid requests and sends all other account errors", () => {
    for (const status of [400, 404, 405, 406, 415, 422]) {
      expect(shouldNotifyAccountError({ status })).toBe(false);
    }
    for (const status of [401, 402, 403, 408, 409, 429, 500, 503, undefined]) {
      expect(shouldNotifyAccountError({ status })).toBe(true);
    }
  });

  it("reports the lowest relevant quota percentage", () => {
    expect(summarizeQuotaPercent({
      quotas: {
        session: { remaining: 80, total: 100 },
        weekly: { used: 75, total: 100 },
        review_weekly: { remaining: 0, total: 100 },
      },
    }, "codex", "gpt-5.6-sol")).toBe("25% (weekly)");

    expect(summarizeQuotaPercent({
      quotas: {
        "gemini-3.1-flash-image": { remainingPercentage: 64 },
        "gemini-3.1-pro": { remainingPercentage: 5 },
      },
    }, "antigravity", "gemini-3.1-flash-image")).toBe("64% (gemini-3.1-flash-image)");
  });

  it("shows only accounts with quota or no known error", () => {
    expect(shouldDisplayRemainingAccount({ quotaSummary: "0% (session)", hasError: false })).toBe(false);
    expect(shouldDisplayRemainingAccount({ quotaSummary: "1% (weekly)", hasError: true })).toBe(true);
    expect(shouldDisplayRemainingAccount({ quotaSummary: "unknown", hasError: true })).toBe(false);
    expect(shouldDisplayRemainingAccount({ quotaSummary: "unknown", hasError: false })).toBe(true);
  });
});
