// Apply: the only code in this plugin that writes outside its own database.
//
// Invariant 4 (PRODUCT.md) is the reason this file is small and boring. Apply
// writes ONE file, into ONE directory, whose name is computed here and never
// taken from the draft. There is no code path that opens a skill file, and
// there is no parameter that could redirect the write: `improvementsDir` comes
// from a setting and the filename comes from the date and a slug. A draft that
// names `~/.agents/skills/deliver/SKILL.md` as its home has that path RENDERED
// INTO the improvements file as text, and the skill file itself is untouched.
//
// The optional second write, a `proposed` row on a repo's findings register,
// is append-only, off by default, and gated on the repo being on its default
// branch — a register is written by the serial gc pass on the default branch
// (retro schema.md Ownership), so appending from a feature branch would put a
// row in a file that branch is going to throw away.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROSE_RUNG, RUNGS, type DraftView } from "./contract.js";
import type { ClusterView, CorrectionView } from "./contract.js";

/** Recurrence at which gc.md 3a forbids a prose adoption. */
export const RECURRENCE_CAP = 2;

export function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Why a draft may not be applied, or null.
 *
 * gc.md 3a: a row on its second recurrence may not be re-adopted as harness
 * prose. The message names the mechanical rungs rather than just refusing,
 * because the person reading it has to pick one and the whole point of the
 * rule is to move the fix onto a carrier that cannot be forgotten.
 */
export function applyBlockReason(draft: DraftView): string | null {
  if (draft.rung === PROSE_RUNG && draft.recurrence >= RECURRENCE_CAP) {
    return [
      `recurrence ${draft.recurrence} with rung 1 (prose) is blocked by the`,
      "recurrence cap: a row on its second recurrence may not be re-adopted as",
      "harness text. Reclassify to a mechanical carrier - rung 3 (a repo lint,",
      "check or CI rule whose message instructs the agent), rung 5 (a check in",
      "scripts/verify-stack.sh), or rung 6 (a repo ops binding) - or retire it",
      "with rationale.",
    ].join(" ");
  }
  if (draft.state === "applied") {
    return `draft ${draft.id} is already applied at ${draft.appliedPath ?? "an unrecorded path"}`;
  }
  if (draft.state === "rejected") {
    return `draft ${draft.id} is rejected; edit it before applying`;
  }
  if (!draft.ruleText && !draft.patchUnifiedDiff) {
    return `draft ${draft.id} carries neither a patch nor rule text`;
  }
  return null;
}

/** `2026-09-01_a-slug-from-the-signature`. */
export function slugify(signature: string): string {
  const slug = signature
    .split("|")
    .slice(1)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "distilled-correction";
}

export function improvementFileName(signature: string, at: Date): string {
  const date = at.toISOString().slice(0, 10);
  return `${date}_${slugify(signature)}.md`;
}

/** The improvements document. Evidence, home, rung, carrier, success signal. */
export function renderImprovement(input: {
  draft: DraftView;
  cluster: ClusterView | null;
  evidence: readonly CorrectionView[];
  at: Date;
}): string {
  const { draft, cluster, evidence, at } = input;
  const lines: string[] = [
    `# ${cluster?.causeClass ?? "untagged"}: distilled correction ${draft.id}`,
    "",
    `Date: ${at.toISOString().slice(0, 10)}. Source: observatory distillery, ` +
      `${evidence.length} correction(s) across ${draft.recurrence} run(s).`,
    "",
    "## Fix",
    "",
    `- home: ${draft.homeFile ?? "unassigned"}`,
    `- rung: ${draft.rung ?? "unassigned"}${
      draft.rung ? ` - ${RUNGS[draft.rung]}` : ""
    }`,
    `- recurrence: ${draft.recurrence}`,
    "",
  ];

  if (draft.patchUnifiedDiff) {
    lines.push("### Patch", "", "```diff", draft.patchUnifiedDiff, "```", "");
  }
  if (draft.ruleText) {
    lines.push("### Rule", "", draft.ruleText, "");
  }

  lines.push(
    "## Success signal",
    "",
    draft.successSignal ?? "none stated - this fix is not falsifiable as drafted.",
    "",
    "## Rationale",
    "",
    draft.rationale ?? "none stated.",
    "",
    "## Evidence",
    "",
  );
  // The previews are the ones the store holds, which are redacted by
  // construction. Nothing is re-read from the source artifacts here: that
  // would reintroduce unredacted text on the last hop before the write.
  for (const item of evidence) {
    lines.push(
      `- \`${item.source}\` (confidence ${item.confidence.toFixed(2)}): ${item.preview}`,
    );
  }
  if (evidence.length === 0) lines.push("- none recorded.");
  lines.push("");
  return lines.join("\n");
}

export interface ApplyDeps {
  improvementsDir: string;
  appendFindings: boolean;
  now(): Date;
}

export interface ApplyResult {
  writtenPath: string | null;
  blocked: string | null;
  /** Set when the findings row was appended. */
  findingsPath: string | null;
}

/**
 * Write the improvement. The only filesystem write distillery performs.
 */
export function applyDraft(
  deps: ApplyDeps,
  draft: DraftView,
  cluster: ClusterView | null,
  evidence: readonly CorrectionView[],
): ApplyResult {
  const blocked = applyBlockReason(draft);
  if (blocked) return { writtenPath: null, blocked, findingsPath: null };

  const at = deps.now();
  const dir = expandHome(deps.improvementsDir);
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    improvementFileName(cluster?.signature ?? draft.id, at),
  );
  writeFileSync(
    path,
    renderImprovement({ draft, cluster, evidence, at }),
    "utf8",
  );

  const findingsPath = deps.appendFindings
    ? appendFindingsRow(draft, cluster, evidence, at)
    : null;

  return { writtenPath: path, blocked: null, findingsPath };
}

/**
 * Append one `proposed` row to the target repo's findings register.
 *
 * Returns null and writes nothing when the repo cannot be determined, the
 * register does not exist, or the repo is not on its default branch. Every one
 * of those is a normal state, not an error: the improvements file is the
 * deliverable and this row is a convenience.
 */
export function appendFindingsRow(
  draft: DraftView,
  cluster: ClusterView | null,
  evidence: readonly CorrectionView[],
  at: Date,
): string | null {
  const repo = evidence
    .map((item) => item.runFolder)
    .filter((folder): folder is string => folder !== null)
    .map((folder) => {
      const index = folder.indexOf("/docs/specs/");
      return index === -1 ? null : folder.slice(0, index);
    })
    .find((value): value is string => value !== null);
  if (!repo) return null;

  const path = join(repo, ".agents", "retro", "FINDINGS.md");
  if (!existsSync(path)) return null;
  if (!isOnDefaultBranch(repo)) return null;

  const row = [
    "",
    `| ${nextFindingId(path)} | ${at.toISOString().slice(0, 10)} | ` +
      `${(draft.ruleText ?? draft.rationale ?? cluster?.signature ?? draft.id)
        .split("\n")[0]
        ?.slice(0, 120)} | ` +
      `${cluster?.causeClass ?? "untagged"} | proposed | ` +
      `${draft.homeFile ?? "unassigned"} | ` +
      `${draft.successSignal ?? "none stated"} | pending |`,
  ].join("");
  appendFileSync(path, `${row}\n`, "utf8");
  return path;
}

/** `F-<n>` one past the register's highest id. */
export function nextFindingId(path: string): string {
  try {
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    let max = 0;
    for (const match of text.matchAll(/\|\s*F-(\d+)\s*\|/g)) {
      max = Math.max(max, Number(match[1]));
    }
    return `F-${max + 1}`;
  } catch {
    return "F-?";
  }
}

/** True when `repo`'s checked-out branch is its remote default. */
export function isOnDefaultBranch(repo: string): boolean {
  try {
    const current = execFileSync("git", ["branch", "--show-current"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    if (!current) return false;
    // `origin/HEAD` is the recorded default. When it is absent (a fresh clone
    // that never ran `remote set-head`), fall back to the conventional names
    // rather than guessing that the current branch is the default.
    let head = "";
    try {
      head = execFileSync(
        "git",
        ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch {
      head = "";
    }
    const fallback = current === "main" || current === "master";
    return head ? head === `origin/${current}` : fallback;
  } catch {
    return false;
  }
}
