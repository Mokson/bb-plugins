import { expect, test } from "vitest";
import { failureSignature, normalizeMessage } from "../src/audit/failures.js";

test("the same failure keeps one signature across ids, paths and counts", () => {
  const first = failureSignature(
    "provider-error",
    "request 9f2ab41c8de7 failed after 3 retries writing /Users/max/repo/src/a.ts",
  );
  const second = failureSignature(
    "provider-error",
    "request 71bc00ff4a19 failed after 11 retries writing /home/ci/work/src/zzz.ts",
  );

  expect(first).toBe(second);
});

test("a different category is a different failure even with the same words", () => {
  expect(failureSignature("provider-error", "timeout")).not.toBe(
    failureSignature("tool-error", "timeout"),
  );
});

test("normalization is idempotent, so a signature never drifts", () => {
  const once = normalizeMessage("ABC-123 failed at /tmp/x/y.log after 4s");

  expect(normalizeMessage(once)).toBe(once);
  expect(once).not.toMatch(/\d/u);
});
