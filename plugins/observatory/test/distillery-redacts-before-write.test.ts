// Invariant 11: distillery text is redacted before any write — every class,
// with per-rule counts, and a 1200 character cap.
import { describe, expect, it } from "vitest";
import {
  PREVIEW_MAX_CHARS,
  hasUnredacted,
  parseCounts,
  redact,
  serializeCounts,
} from "../src/distillery/redact.js";

/** One fixture carrying every pattern the rules must catch. */
const FIXTURE = [
  "the seat leaked sk-proj-abcdefghijklmnopqrstuvwxyz012345 into the log",
  "and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and xoxb-1234567890-abcdef",
  "and AKIAIOSFODNN7EXAMPLE, with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh",
  "the digest was 5f4dcc3b5aa765d61d8327deb882cf99aa112233445566778899aabbccddeeff",
  "mail maksym.moklyak@gmail.com about it, the host was 203.0.113.42",
  "but 127.0.0.1 and 192.168.1.10 are fine",
  "the file lived at /Users/mokson/Projects/thing/src/a.ts",
  "and /home/runner/work/repo/main.go, tracked as MKL-473 and #1234",
].join("\n");

describe("distillery redacts before any write", () => {
  it("strips every class and counts each rule", () => {
    const result = redact(FIXTURE);

    // Secrets: no recognisable key material survives.
    expect(result.text).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(result.text).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(result.text).not.toContain("xoxb-1234567890");
    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(result.text).not.toContain("5f4dcc3b5aa765d61d8327deb882cf99");

    expect(result.text).not.toContain("maksym.moklyak@gmail.com");
    expect(result.text).not.toContain("203.0.113.42");
    expect(result.text).not.toContain("/Users/mokson");
    expect(result.text).not.toContain("/home/runner");
    expect(result.text).not.toContain("MKL-473");
    expect(result.text).not.toContain("#1234");

    // Every rule reports a non-zero count: a silent zero would mean a rule
    // ran and matched nothing, which is what a broken pattern looks like.
    expect(result.counts.secret).toBeGreaterThanOrEqual(6);
    expect(result.counts.email).toBe(1);
    expect(result.counts.ip).toBe(1);
    expect(result.counts["home-path"]).toBe(2);
    expect(result.counts["tracker-id"]).toBe(2);
  });

  it("keeps private addresses and the path below the home root", () => {
    const result = redact(FIXTURE);
    // Private space is not a disclosure, and masking it would cost the
    // evidence line its only useful detail.
    expect(result.text).toContain("127.0.0.1");
    expect(result.text).toContain("192.168.1.10");
    // The repo-relative path is what makes a draft actionable.
    expect(result.text).toContain("/Projects/thing/src/a.ts");
  });

  it("caps a preview at 1200 characters", () => {
    const long = redact("a ".repeat(4000));
    expect(long.text.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    expect(long.truncated).toBe(true);
  });

  it("masks before truncating, so a cut cannot leave a secret in the clear", () => {
    // The secret sits past the cap; truncate-then-mask would keep its head.
    const padded = `${"x ".repeat(700)}sk-proj-abcdefghijklmnopqrstuvwxyz012345`;
    const result = redact(padded);
    expect(result.text).not.toContain("sk-proj-abcdefghij");
  });

  it("is idempotent: redacting a redacted preview changes nothing", () => {
    const once = redact(FIXTURE);
    expect(redact(once.text).text).toBe(once.text);
    expect(hasUnredacted(once.text)).toBe(false);
  });

  it("round-trips its counts through storage", () => {
    const counts = redact(FIXTURE).counts;
    expect(parseCounts(serializeCounts(counts))).toEqual(counts);
    expect(parseCounts(null)).toEqual({});
    expect(parseCounts("not json")).toEqual({});
  });
});
