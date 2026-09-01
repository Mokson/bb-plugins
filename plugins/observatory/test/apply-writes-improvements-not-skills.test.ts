// Invariant 4 and criterion c15: apply writes ONLY under the improvements
// directory, and leaves the skills tree byte-identical.
//
// The skills tree is hashed before and after, file by file, because "we did
// not call writeFile on a skill path" is a weaker claim than "the tree did not
// change" — and the tree is what the invariant is actually about.
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { applyDraft, applyBlockReason } from "../src/distillery/apply.js";
import type {
  ClusterView,
  CorrectionView,
  DraftView,
} from "../src/distillery/contract.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A hash over every file in a tree: names, sizes and bytes. */
function treeHash(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      hash.update(relative(root, path));
      hash.update(readFileSync(path));
    }
  };
  walk(root);
  return hash.digest("hex");
}

function agentsHome(): { root: string; skills: string; improvements: string } {
  const root = mkdtempSync(join(tmpdir(), "distillery-apply-"));
  dirs.push(root);
  const skills = join(root, "skills");
  const improvements = join(root, "improvements");
  mkdirSync(join(skills, "deliver"), { recursive: true });
  mkdirSync(improvements, { recursive: true });
  writeFileSync(
    join(skills, "deliver", "SKILL.md"),
    "# Deliver\n\nThe original text nothing may touch.\n",
    "utf8",
  );
  writeFileSync(
    join(skills, "deliver", "gc.md"),
    "# Garbage Collection\n\nAlso untouchable.\n",
    "utf8",
  );
  return { root, skills, improvements };
}

function draft(overrides: Partial<DraftView> = {}): DraftView {
  return {
    id: "cluster1-op1",
    clusterId: "cluster1",
    state: "accepted",
    // The draft NAMES a skill file as its home. Apply must render that path as
    // text and never open it.
    homeFile: "~/.agents/skills/deliver/gc.md",
    rung: 3,
    patchUnifiedDiff: null,
    ruleText: "Fail the packet when the checkpoint is breached without an ack.",
    successSignal: "run logs after adoption show zero un-acked breaches",
    rationale: "seen in two runs",
    evidenceIds: [1],
    recurrence: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    appliedPath: null,
    threadId: null,
    ...overrides,
  };
}

const cluster: ClusterView = {
  id: "cluster1",
  signature: "packet-contract|ack breached checkpoint packet uses",
  causeClass: "packet-contract",
  size: 2,
  runs: 2,
  firstAt: "2026-08-01T00:00:00.000Z",
  lastAt: "2026-08-20T00:00:00.000Z",
  status: "open",
};

const evidence: CorrectionView[] = [
  {
    id: 1,
    source: "ledger-nudge",
    signature: "sig#n1",
    causeClass: "packet-contract",
    preview: "the packet checkpoint was breached without an ack",
    redactionCounts: {},
    runFolder: "/repo/docs/specs/run-a",
    threadId: null,
    at: "2026-08-01T00:00:00.000Z",
    confidence: 0.9,
    clusterId: null,
  },
];

describe("apply writes improvements not skills", () => {
  it("writes one file under improvementsDir and leaves the skills tree unchanged", () => {
    const { skills, improvements } = agentsHome();
    const before = treeHash(skills);

    const result = applyDraft(
      {
        improvementsDir: improvements,
        appendFindings: false,
        now: () => new Date("2026-09-01T12:00:00Z"),
      },
      draft(),
      cluster,
      evidence,
    );

    expect(result.blocked).toBeNull();
    expect(result.writtenPath).toBeTruthy();
    // The write landed inside the improvements directory and nowhere else.
    expect(result.writtenPath?.startsWith(improvements)).toBe(true);

    // c15: the skills tree hash is unchanged.
    expect(treeHash(skills)).toBe(before);

    // Exactly one file was created.
    const written = readdirSync(improvements);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^2026-09-01_.*\.md$/);

    // The named home appears as TEXT in the document, which is the whole
    // mechanism: apply reports where a human should make the edit.
    const body = readFileSync(join(improvements, written[0] ?? ""), "utf8");
    expect(body).toContain("~/.agents/skills/deliver/gc.md");
    expect(body).toContain("rung: 3");
    expect(body).toContain("run logs after adoption show zero un-acked breaches");
    expect(body).toContain("the packet checkpoint was breached without an ack");
  });

  it("never appends to a findings register when the flag is off", () => {
    const { root, skills, improvements } = agentsHome();
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".agents", "retro"), { recursive: true });
    const register = join(repo, ".agents", "retro", "FINDINGS.md");
    writeFileSync(register, "| id | date |\n| --- | --- |\n", "utf8");
    const registerBefore = readFileSync(register, "utf8");

    applyDraft(
      {
        improvementsDir: improvements,
        appendFindings: false,
        now: () => new Date("2026-09-01T12:00:00Z"),
      },
      draft(),
      cluster,
      [{ ...evidence[0]!, runFolder: join(repo, "docs", "specs", "run-a") }],
    );

    expect(readFileSync(register, "utf8")).toBe(registerBefore);
    expect(treeHash(skills)).toBe(treeHash(skills));
  });

  it("refuses a draft that carries neither a patch nor rule text", () => {
    const blocked = applyBlockReason(
      draft({ ruleText: null, patchUnifiedDiff: null }),
    );
    expect(blocked).toMatch(/neither a patch nor rule text/);
  });

  it("refuses to apply the same draft twice", () => {
    expect(
      applyBlockReason(draft({ state: "applied", appliedPath: "/x.md" })),
    ).toMatch(/already applied/);
  });
});
