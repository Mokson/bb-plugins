// A drafting reply that does not parse becomes a REJECTED draft carrying the
// redacted raw text — never a silent drop.
//
// A dropped batch is the expensive failure: the cluster stays eligible, so the
// next run pays for the same batch again, forever. A rejected draft costs one
// queue row and makes the failure visible.
import { afterEach, describe, expect, it } from "vitest";
import { TempDatabase } from "./fakes.js";
import { DistilleryStore } from "../src/distillery/store.js";
import { hasUnredacted } from "../src/distillery/redact.js";
import { isAllowedHome, parseDraftReply, storeBatchDrafts } from "../src/distillery/draft.js";
import type { Cluster } from "../src/distillery/cluster.js";

const temps: TempDatabase[] = [];
afterEach(() => {
  for (const temp of temps.splice(0)) temp.dispose();
});

function freshStore(): DistilleryStore {
  const temp = new TempDatabase();
  temps.push(temp);
  return new DistilleryStore(temp.openDatabase());
}

const SIGNATURE = "packet-contract|ack breached checkpoint packet uses";

const cluster: Cluster = {
  id: "cluster1",
  signature: SIGNATURE,
  causeClass: "packet-contract",
  size: 2,
  runs: 2,
  firstAt: "2026-08-01T00:00:00.000Z",
  lastAt: "2026-08-20T00:00:00.000Z",
  status: "open",
  qualifies: true,
  members: [
    {
      id: 1,
      source: "ledger-nudge",
      signature: "sig#n1",
      causeClass: "packet-contract",
      preview: "checkpoint breached without an ack",
      redactionCounts: {},
      runFolder: "/repo/docs/specs/run-a",
      threadId: null,
      at: "2026-08-01T00:00:00.000Z",
      confidence: 0.9,
      clusterId: null,
    },
  ],
};

const NOW = new Date("2026-09-01T12:00:00Z");

describe("a draft parse failure lands as a rejected draft", () => {
  it("reports a failure for a reply that is not JSON at all", () => {
    const result = parseDraftReply("I could not do that, sorry.");
    expect(result.drafts).toHaveLength(0);
    expect(result.failure).toContain("could not do that");
  });

  it("reports a failure for JSON with no usable draft", () => {
    // Valid JSON that produced nothing reviewable is still a paid-for batch
    // that returned nothing.
    expect(parseDraftReply('{"drafts":[]}').failure).toBeTruthy();
  });

  it("stores a rejected draft carrying the redacted raw text", () => {
    const store = freshStore();
    const stored = storeBatchDrafts(
      { store },
      [cluster],
      "sorry, the key sk-proj-abcdefghijklmnopqrstuvwxyz012345 broke me",
      "thr-1",
      NOW,
    );

    expect(stored).toHaveLength(1);
    expect(stored[0]?.state).toBe("rejected");
    // The raw text is kept for diagnosis, and it went through redaction on the
    // way in like everything else.
    expect(stored[0]?.rationale).toBeTruthy();
    expect(stored[0]?.rationale).not.toContain(
      "abcdefghijklmnopqrstuvwxyz012345",
    );
    expect(hasUnredacted(stored[0]?.rationale ?? "")).toBe(false);

    // The cluster now HAS a draft, so it is not re-batched and re-charged.
    expect(store.draftForCluster("cluster1")?.state).toBe("rejected");
  });

  it("rejects a cluster the reply skipped, rather than dropping it", () => {
    const store = freshStore();
    const stored = storeBatchDrafts(
      { store },
      [cluster],
      JSON.stringify({
        drafts: [
          {
            signature: "a-different-cluster",
            rule_text: "something else",
            rung: 3,
          },
        ],
      }),
      "thr-1",
      NOW,
    );
    expect(stored[0]?.state).toBe("rejected");
    expect(stored[0]?.rationale).toMatch(/covered no draft/);
  });

  it("parses a good reply into a pending draft", () => {
    const store = freshStore();
    const stored = storeBatchDrafts(
      { store },
      [cluster],
      // Fenced, because models wrap strict JSON often enough to be worth it.
      "```json\n" +
        JSON.stringify({
          drafts: [
            {
              signature: SIGNATURE,
              home_file: "~/.agents/skills/deliver/gc.md",
              rung: 3,
              patch_unified_diff: null,
              rule_text: "Fail the packet on an un-acked breach.",
              success_signal: "zero un-acked breaches after adoption",
              rationale: "two runs",
              evidence_ids: [1],
              recurrence: 2,
            },
          ],
        }) +
        "\n```",
      "thr-1",
      NOW,
    );
    expect(stored[0]?.state).toBe("pending");
    expect(stored[0]?.rung).toBe(3);
    expect(stored[0]?.homeFile).toBe("~/.agents/skills/deliver/gc.md");
    expect(stored[0]?.evidenceIds).toEqual([1]);
  });

  it("drops a home outside the ~/.agents allowlist", () => {
    expect(isAllowedHome("~/.agents/skills/deliver/gc.md")).toBe(true);
    expect(isAllowedHome("~/.agents/agents/deliver-impl.md")).toBe(true);
    expect(isAllowedHome("~/.agents/improvements/x.md")).toBe(true);
    expect(isAllowedHome("~/.ssh/id_rsa")).toBe(false);
    expect(isAllowedHome("/etc/passwd")).toBe(false);
    // Traversal is rejected as a string, not resolved and then checked.
    expect(isAllowedHome("~/.agents/skills/../../.ssh/id_rsa")).toBe(false);

    const parsed = parseDraftReply(
      JSON.stringify({
        drafts: [
          { signature: SIGNATURE, home_file: "~/.ssh/id_rsa", rule_text: "x" },
        ],
      }),
    );
    expect(parsed.drafts[0]?.homeFile).toBeNull();
  });
});
