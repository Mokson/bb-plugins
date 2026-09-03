import { describe, expect, it } from "vitest";
import {
  compactText,
  isExpiredPushStatus,
  isRetryablePushStatus,
  MAX_DETAIL_LENGTH,
  MAX_PROJECT_LENGTH,
  MAX_TITLE_LENGTH,
  meetsMinimumDuration,
  notificationContent,
  notificationTag,
  notificationTitle,
  notificationUrgency,
  resolveThreadTitle,
  threadHref,
} from "./notification-policy";

describe("notification policy", () => {
  it("compacts whitespace and limits lock-screen detail", () => {
    const text = `  first\n\n${"x".repeat(300)}  `;
    const result = compactText(text);

    expect(result).toHaveLength(MAX_DETAIL_LENGTH);
    expect(result).toMatch(/^first x+/);
    expect(result).toMatch(/…$/);
  });

  it("compacts only primitives and drops objects instead of stringifying them", () => {
    expect(compactText(42)).toBe("42");
    expect(compactText(true)).toBe("true");
    expect(compactText({ text: "hi" })).toBeNull();
    expect(compactText(["hi"])).toBeNull();
    expect(compactText(null)).toBeNull();
    expect(compactText(undefined)).toBeNull();
  });

  it("uses the fallback title and a safe final fallback", () => {
    expect(
      resolveThreadTitle({ title: null, titleFallback: "  Draft chat  " }),
    ).toBe("Draft chat");
    expect(
      resolveThreadTitle({ title: "  ", titleFallback: "Useful fallback" }),
    ).toBe("Useful fallback");
    expect(resolveThreadTitle({ title: "  ", titleFallback: null })).toBe(
      "Untitled chat",
    );
  });

  it("limits notification titles separately from message details", () => {
    expect(
      resolveThreadTitle({ title: "t".repeat(200), titleFallback: null }),
    ).toHaveLength(MAX_TITLE_LENGTH);
  });

  it("encodes project and thread ids in the click-through URL", () => {
    expect(threadHref("project/a", "thread b")).toBe(
      "/projects/project%2Fa/threads/thread%20b",
    );
  });

  it("uses the projectless thread route for personal or missing projects", () => {
    expect(threadHref("proj_personal", "thread a")).toBe(
      "/threads/thread%20a",
    );
    expect(threadHref(null, "thread a")).toBe("/threads/thread%20a");
  });

  it("includes the project while preserving room for the thread title", () => {
    const title = notificationTitle(
      "p".repeat(100),
      "A useful thread title that should remain visible",
    );
    expect(title).toHaveLength(MAX_TITLE_LENGTH);
    expect(title).toContain(`${"p".repeat(MAX_PROJECT_LENGTH - 1)}… · A useful`);
    expect(notificationTitle(null, "Build release")).toBe("Build release");
  });

  it("leads with the thread and only adds details when enabled", () => {
    expect(
      notificationContent(
        "idle",
        "Website",
        "Build release",
        "All done",
        false,
      ),
    ).toEqual({
      title: "Website · Build release",
      body: "bb agent finished",
    });
    expect(
      notificationContent(
        "failed",
        null,
        "Build release",
        "Tests failed",
        true,
      ),
    ).toEqual({
      title: "Build release",
      body: "bb agent failed — Tests failed",
    });
  });

  it("recognizes push subscriptions that should be removed", () => {
    expect(isExpiredPushStatus(404)).toBe(true);
    expect(isExpiredPushStatus(410)).toBe(true);
    expect(isExpiredPushStatus(429)).toBe(false);
    expect(isExpiredPushStatus(null)).toBe(false);
  });

  it("retries only transient push failures", () => {
    expect(isRetryablePushStatus(null)).toBe(true);
    expect(isRetryablePushStatus(408)).toBe(true);
    expect(isRetryablePushStatus(429)).toBe(true);
    expect(isRetryablePushStatus(503)).toBe(true);
    expect(isRetryablePushStatus(400)).toBe(false);
    expect(isRetryablePushStatus(410)).toBe(false);
  });

  it("announces a waiting agent under its own tag and urgency", () => {
    expect(
      notificationContent("pending", "Website", "Build release", "Approve?", true),
    ).toEqual({
      title: "Website · Build release",
      body: "bb agent is waiting for you — Approve?",
    });
    expect(
      notificationContent("pending", null, "Build release", "Approve?", false)
        .body,
    ).toBe("bb agent is waiting for you");
    expect(notificationTag("pending", "thread-1")).toBe(
      "bb-push-notify:pending:thread-1",
    );
    expect(notificationTag("idle", "thread-1")).not.toBe(
      notificationTag("pending", "thread-1"),
    );
    expect(notificationUrgency("pending")).toBe("high");
    expect(notificationUrgency("failed")).toBe("high");
    expect(notificationUrgency("idle")).toBe("normal");
  });

  it("treats an unknown turn duration as long enough", () => {
    expect(meetsMinimumDuration(5_000, 30)).toBe(false);
    expect(meetsMinimumDuration(30_000, 30)).toBe(true);
    expect(meetsMinimumDuration(null, 30)).toBe(true);
    expect(meetsMinimumDuration(1, 0)).toBe(true);
  });
});
