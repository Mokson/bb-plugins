// The signal scanners, ordered by precision.
//
// Every scanner answers one question: "where did someone already write down
// that this run went wrong?" A ledger nudge is the best answer there is — a
// human tagged the cause class at the moment of the failure — and a transcript
// inference is the worst, a guess assembled from item ordering. That ordering
// is the whole design: `SCANNERS` runs best-first and each scanner declares a
// `baseConfidence`, so a cluster built mostly from nudges outranks one built
// from transcript guesses without any caller having to weigh sources.
//
// Every scanner is pure over its inputs and returns `Correction` values whose
// preview is already `Redacted`. Nothing here writes; `runScan` below is the
// only writer, and it takes what the scanners return.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Database } from "better-sqlite3";
import { redact, type Redacted } from "./redact.js";
import {
  isCanonicalCauseClass,
  type ScanCounts,
  type SignalSource,
} from "./contract.js";

/** One mined correction, before the store gives it an id. */
export interface Correction {
  source: SignalSource;
  signature: string;
  causeClass: string | null;
  preview: Redacted;
  runFolder: string | null;
  threadId: string | null;
  at: string;
  confidence: number;
}

/** What a scanner may read. Injected so tests drive real files in a tmpdir. */
export interface ScanContext {
  /** Run folders to scan, absolute. */
  runFolders: readonly string[];
  /** The ledger database, for the obs_signal and transcript scanners. */
  db: Database | null;
  /** Fallback timestamp for artifacts that carry none. */
  now(): string;
}

export interface Scanner {
  source: SignalSource;
  /** Precision prior, 0..1. The ranking in this file's header, as numbers. */
  baseConfidence: number;
  scan(ctx: ScanContext): Correction[];
}

// ---------------------------------------------------------------------------
// Shared parsing helpers
// ---------------------------------------------------------------------------

function readIfPresent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** The file's mtime as an ISO string, or `now`. Ledger rows carry no date. */
function fileTime(path: string, ctx: ScanContext): string {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return ctx.now();
  }
}

/**
 * The body of one `## <name>` section, up to the next `## ` heading.
 *
 * Ledgers in the wild are hand-maintained, so this tolerates trailing spaces
 * and a missing trailing newline rather than requiring the template's exact
 * bytes.
 */
export function section(markdown: string, name: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === `## ${name}`.toLowerCase(),
  );
  if (start === -1) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    body.push(line);
  }
  return body;
}

/**
 * Split one ledger row into its pipe-delimited cells, dropping the leading
 * `- ` and the per-section serial id.
 *
 * Returns null for anything that is not a row, which in a hand-written ledger
 * includes blank lines, prose paragraphs, and comment lines.
 */
export function ledgerRow(
  line: string,
): { id: string; cells: string[] } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("- ")) return null;
  const cells = trimmed
    .slice(2)
    .split("|")
    .map((cell) => cell.trim());
  const first = cells[0] ?? "";
  // `n1`, `g12`, `d3`. A row without one is a continuation line, not a record.
  if (!/^[a-z]\d+$/i.test(first)) return null;
  return { id: first, cells: cells.slice(1) };
}

/**
 * Keep a ledger's cause-class tag, canonical or not.
 *
 * Real ledgers carry tags outside the retro taxonomy — `tooling-guard`,
 * `packet-contract`, `orchestrator-error`, `provisioning`, `spec-defect` —
 * because the taxonomy is extended by gc decision and the runs got there
 * first. Dropping an unrecognised tag would throw away the highest-precision
 * field on the highest-precision source, so the tag is kept verbatim and only
 * `canonical` records whether it is one the taxonomy knows.
 */
export function normalizeCauseClass(
  value: string | undefined,
): { causeClass: string | null; canonical: boolean } {
  const tag = (value ?? "").trim().toLowerCase();
  if (!tag || tag === "-" || tag.includes(" ")) {
    return { causeClass: null, canonical: false };
  }
  return { causeClass: tag, canonical: isCanonicalCauseClass(tag) };
}

/**
 * A short, stable descriptor for one observation.
 *
 * Lower-cased and stripped of digits so "56 tool uses against a 35-use
 * checkpoint" and "41 against 30" produce the same signature; the numbers are
 * what differ between two instances of one failure, not what identifies it.
 */
export function signatureOf(
  source: SignalSource,
  causeClass: string | null,
  text: string,
): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 8);
  return [source, causeClass ?? "untagged", words.join("-")]
    .filter(Boolean)
    .join(":");
}

function correction(
  scanner: Scanner,
  fields: {
    causeClass: string | null;
    text: string;
    runFolder: string | null;
    threadId?: string | null;
    at: string;
    confidenceDelta?: number;
    /**
     * The row's own id within its artifact (`n1`, `g2`, a table position).
     *
     * Part of the stored signature, and so part of the row identity that makes
     * a re-scan a no-op. Without it, two DIFFERENT nudges that happen to
     * describe one failure in one ledger collapse into a single correction —
     * they share a source, a run folder and the file's mtime — and a real
     * second occurrence is lost. Clustering is unaffected: it keys on the
     * cause class and the preview, never on this field.
     */
    rowId?: string;
  },
): Correction {
  const preview = redact(fields.text);
  const base = signatureOf(scanner.source, fields.causeClass, preview.text);
  return {
    source: scanner.source,
    signature: fields.rowId ? `${base}#${fields.rowId}` : base,
    causeClass: fields.causeClass,
    preview,
    runFolder: fields.runFolder,
    threadId: fields.threadId ?? null,
    at: fields.at,
    confidence: Math.max(
      0,
      Math.min(1, scanner.baseConfidence + (fields.confidenceDelta ?? 0)),
    ),
  };
}

// ---------------------------------------------------------------------------
// 1. LEDGER `## nudges` — cause-class pre-tagged, the highest-precision source
// ---------------------------------------------------------------------------

const nudgeScanner: Scanner = {
  source: "ledger-nudge",
  baseConfidence: 0.9,
  scan(ctx) {
    const out: Correction[] = [];
    for (const folder of ctx.runFolders) {
      const path = join(folder, "LEDGER.md");
      const markdown = readIfPresent(path);
      if (!markdown) continue;
      const at = fileTime(path, ctx);
      for (const line of section(markdown, "nudges")) {
        const row = ledgerRow(line);
        if (!row) continue;
        const { causeClass, canonical } = normalizeCauseClass(row.cells[0]);
        const what = row.cells[1] ?? "";
        if (!what) continue;
        out.push(
          correction(nudgeScanner, {
            causeClass,
            text: what,
            runFolder: folder,
            at,
            rowId: row.id,
            // An off-taxonomy tag is still a human tag; it just cannot be
            // cross-referenced against the retro corpus, so it drops a notch.
            confidenceDelta: canonical ? 0 : -0.1,
          }),
        );
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 2. LEDGER `## gates` — rows the user rejected or redirected
// ---------------------------------------------------------------------------

/** Gate decisions that mean the run proposed the wrong thing. */
const REJECTION_LEXICON =
  /\b(reject|rejected|denied|declined|no\b|instead|redirect|descope|drop|retract|corrected|not approved|refused|revert)/i;

/** Decisions that mean the gate went the way the run asked. */
const APPROVAL_LEXICON = /\b(approved|user-approved|accepted|proceed|yes\b|ok\b)/i;

const gateScanner: Scanner = {
  source: "ledger-gate",
  baseConfidence: 0.75,
  scan(ctx) {
    const out: Correction[] = [];
    for (const folder of ctx.runFolders) {
      const path = join(folder, "LEDGER.md");
      const markdown = readIfPresent(path);
      if (!markdown) continue;
      const at = fileTime(path, ctx);
      for (const line of section(markdown, "gates")) {
        const row = ledgerRow(line);
        if (!row) continue;
        const asked = row.cells[0] ?? "";
        const decided = row.cells[1] ?? "";
        // Only a rejection or a redirect is evidence of a harness failure. A
        // plain approval means the gate worked, and mining it would flood the
        // queue with the runs that went RIGHT.
        const rejected =
          REJECTION_LEXICON.test(decided) && !APPROVAL_LEXICON.test(decided);
        if (!rejected || !asked) continue;
        out.push(
          correction(gateScanner, {
            causeClass: null,
            text: `gate asked: ${asked} / user decided: ${decided}`,
            runFolder: folder,
            at,
            rowId: row.id,
          }),
        );
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 3. LEDGER `## decisions` — parked, then overridden
// ---------------------------------------------------------------------------

const decisionScanner: Scanner = {
  source: "ledger-decision",
  baseConfidence: 0.7,
  scan(ctx) {
    const out: Correction[] = [];
    for (const folder of ctx.runFolders) {
      const path = join(folder, "LEDGER.md");
      const markdown = readIfPresent(path);
      if (!markdown) continue;
      const at = fileTime(path, ctx);
      const rows = section(markdown, "decisions")
        .map(ledgerRow)
        .filter((row): row is { id: string; cells: string[] } => row !== null);
      const parked = rows.filter((row) =>
        (row.cells[0] ?? "").toLowerCase().startsWith("parked:"),
      );
      for (const row of parked) {
        const question = row.cells[0] ?? "";
        // A parked decision is only evidence when something later contradicted
        // it: a later row or a gate that cites this id is the override. A park
        // nobody revisited is a default that held, which is the system working.
        const overridden = [
          ...rows.filter((other) => other.id !== row.id),
          ...section(markdown, "gates")
            .map(ledgerRow)
            .filter((r): r is { id: string; cells: string[] } => r !== null),
        ].some((other) =>
          other.cells.some((cell) =>
            new RegExp(`\\b${row.id}\\b`).test(cell),
          ),
        );
        if (!overridden) continue;
        out.push(
          correction(decisionScanner, {
            causeClass: "shaped-wrong",
            text: `parked decision later overridden: ${question}`,
            runFolder: folder,
            at,
            rowId: row.id,
          }),
        );
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 4. review.json findings, recurring across runs
// ---------------------------------------------------------------------------

interface ReviewFinding {
  id?: string;
  severity?: string;
  category?: string;
  claim?: string;
  file?: string;
}

const reviewScanner: Scanner = {
  source: "review-finding",
  baseConfidence: 0.65,
  scan(ctx) {
    const out: Correction[] = [];
    for (const folder of ctx.runFolders) {
      let names: string[] = [];
      try {
        names = readdirSync(folder);
      } catch {
        continue;
      }
      for (const name of names.filter(
        (n) => n.startsWith("review") && n.endsWith(".json"),
      )) {
        const path = join(folder, name);
        const raw = readIfPresent(path);
        if (!raw) continue;
        let findings: ReviewFinding[] = [];
        try {
          const parsed: unknown = JSON.parse(raw);
          const container = parsed as { findings?: unknown };
          if (Array.isArray(container.findings)) {
            findings = container.findings as ReviewFinding[];
          }
        } catch {
          // Some review artifacts in the corpus carry markdown under a .json
          // name. That is a producer defect, not something to mine around.
          continue;
        }
        const at = fileTime(path, ctx);
        for (const finding of findings) {
          // Minors are style; only the findings that would have blocked a
          // merge are worth a harness fix.
          const severity = (finding.severity ?? "").toLowerCase();
          if (severity !== "major" && severity !== "critical") continue;
          const claim = finding.claim ?? "";
          if (!claim) continue;
          out.push(
            correction(reviewScanner, {
              causeClass:
                finding.category === "correctness" ? "built-wrong" : null,
              text: claim,
              runFolder: folder,
              at,
              confidenceDelta: severity === "critical" ? 0.05 : 0,
            }),
          );
        }
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 5. QA.md Fail rows
// ---------------------------------------------------------------------------

const qaScanner: Scanner = {
  source: "qa-fail",
  baseConfidence: 0.6,
  scan(ctx) {
    const out: Correction[] = [];
    for (const folder of ctx.runFolders) {
      const path = join(folder, "QA.md");
      const markdown = readIfPresent(path);
      if (!markdown) continue;
      const at = fileTime(path, ctx);
      for (const line of markdown.split("\n")) {
        if (!line.trim().startsWith("|")) continue;
        const cells = line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim());
        if (cells.length < 2) continue;
        const status = (cells[1] ?? "").toLowerCase();
        if (!/^(fail|blocker|blocked)\b/.test(status)) continue;
        const scenario = cells[0] ?? "";
        if (!scenario || scenario === "---") continue;
        out.push(
          correction(qaScanner, {
            causeClass: "verified-wrong",
            text: `QA ${status}: ${scenario}${cells[3] ? ` — ${cells[3]}` : ""}`,
            runFolder: folder,
            at,
          }),
        );
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 6/7. retro `## Candidates` and FINDINGS rows still `proposed`
// ---------------------------------------------------------------------------

const retroCandidateScanner: Scanner = {
  source: "retro-candidate",
  baseConfidence: 0.55,
  scan(ctx) {
    const out: Correction[] = [];
    for (const folder of ctx.runFolders) {
      let names: string[] = [];
      try {
        names = readdirSync(folder);
      } catch {
        continue;
      }
      for (const name of names.filter(
        (n) => n.toUpperCase().includes("RETRO") && n.endsWith(".md"),
      )) {
        const path = join(folder, name);
        const markdown = readIfPresent(path);
        if (!markdown) continue;
        const at = fileTime(path, ctx);
        for (const line of section(markdown, "Candidates")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("- ")) continue;
          // `title | cause-class | proposed home | success signal`
          const cells = trimmed
            .slice(2)
            .split("|")
            .map((cell) => cell.trim());
          const title = cells[0] ?? "";
          if (!title) continue;
          const { causeClass } = normalizeCauseClass(cells[1]);
          out.push(
            correction(retroCandidateScanner, {
              causeClass,
              text: title,
              runFolder: folder,
              at,
            }),
          );
        }
      }
    }
    return out;
  },
};

/** Repo roots derived from run folders: `<repo>/docs/specs/<run>`. */
export function repoRootOf(runFolder: string): string | null {
  const marker = "/docs/specs/";
  const index = runFolder.indexOf(marker);
  return index === -1 ? null : runFolder.slice(0, index);
}

const retroFindingScanner: Scanner = {
  source: "retro-finding",
  baseConfidence: 0.5,
  scan(ctx) {
    const out: Correction[] = [];
    const seenRepos = new Set<string>();
    for (const folder of ctx.runFolders) {
      const repo = repoRootOf(folder);
      // One register per repo, many run folders per repo: scanning it once per
      // run folder would multiply every row by the run count and manufacture
      // recurrence that does not exist.
      if (!repo || seenRepos.has(repo)) continue;
      seenRepos.add(repo);
      const path = join(repo, ".agents", "retro", "FINDINGS.md");
      const markdown = readIfPresent(path);
      if (!markdown) continue;
      const at = fileTime(path, ctx);
      for (const line of markdown.split("\n")) {
        if (!line.trim().startsWith("|")) continue;
        // `| id | date | title | cause-class | status | home | signal | verdict |`
        const cells = line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim());
        if (cells.length < 5) continue;
        if ((cells[4] ?? "").toLowerCase() !== "proposed") continue;
        const title = cells[2] ?? "";
        if (!title) continue;
        const { causeClass } = normalizeCauseClass(cells[3]);
        out.push(
          correction(retroFindingScanner, {
            causeClass,
            text: title,
            runFolder: folder,
            at,
          }),
        );
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 8. obs_signal rows written by spend, watch and context
// ---------------------------------------------------------------------------

const obsSignalScanner: Scanner = {
  source: "obs-signal",
  baseConfidence: 0.45,
  scan(ctx) {
    if (!ctx.db) return [];
    const rows = ctx.db
      .prepare<
        [],
        {
          kind: string;
          thread_id: string | null;
          opened_at: string;
          payload: string | null;
          run_folder: string | null;
        }
      >(
        `SELECT s.kind, s.thread_id, s.opened_at, s.payload, t.run_folder
           FROM obs_signal s
           LEFT JOIN obs_thread t ON t.thread_id = s.thread_id
          WHERE s.module IN ('spend', 'watch', 'context')
          ORDER BY s.opened_at DESC
          LIMIT 500`,
      )
      .all();
    return rows.map((row) =>
      correction(obsSignalScanner, {
        causeClass: row.kind === "tree-budget" ? "over-production" : null,
        text: `${row.kind}: ${row.payload ?? ""}`,
        runFolder: row.run_folder,
        threadId: row.thread_id,
        at: row.opened_at,
      }),
    );
  },
};

// ---------------------------------------------------------------------------
// 9. Transcript detector — rules only, no model, lowest precision
// ---------------------------------------------------------------------------

/**
 * Item kinds this detector reasons over, as the ledger actually spells them.
 *
 * The core indexer writes bb's own item kinds; `obs_item.name` is the KIND
 * string again, not message text, and `path` is populated only for the file
 * kinds. That shape decides what this detector can and cannot be:
 *
 *  - The STRUCTURAL half is available: a user turn, then the agent touching a
 *    file it had already touched, or repeating a command it had already run.
 *  - The LEXICAL half is not. A confirmation lexicon, and reading a user turn
 *    to decide whether it corrects or merely continues, both need the message
 *    body, and no column carries it. Guessing from item ordering alone would
 *    turn every follow-up question into a "correction", so this scanner
 *    reports the structure it can prove and leaves confidence at the floor.
 *
 * That is why `transcript` sits last in the precision order and is the only
 * source whose corrections never carry a cause class.
 */
const USER_KIND = "userMessage";
const REDO_KINDS = new Set(["fileChange", "commandExecution", "toolCall"]);

/** Items scanned per pass. Bounds the pass on a database of any size. */
const TRANSCRIPT_ITEM_LIMIT = 20000;

const transcriptScanner: Scanner = {
  source: "transcript",
  baseConfidence: 0.2,
  scan(ctx) {
    if (!ctx.db) return [];
    // The shape being detected: a user turn, then the agent redoing something
    // it had already done before that turn — the same file edited again, or
    // the same command re-run. The REDO is the evidence; without it a user
    // turn is just the conversation continuing.
    const rows = ctx.db
      .prepare<
        [number],
        {
          thread_id: string;
          seq: number;
          kind: string | null;
          name: string | null;
          path: string | null;
          started_at: string | null;
          run_folder: string | null;
        }
      >(
        `SELECT i.thread_id, i.seq, i.kind, i.name, i.path, i.started_at,
                t.run_folder
           FROM obs_item i
           LEFT JOIN obs_thread t ON t.thread_id = i.thread_id
          WHERE i.kind IS NOT NULL
          ORDER BY i.thread_id, i.seq
          LIMIT ?`,
      )
      .all(TRANSCRIPT_ITEM_LIMIT);

    const out: Correction[] = [];
    const byThread = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byThread.get(row.thread_id) ?? [];
      list.push(row);
      byThread.set(row.thread_id, list);
    }

    for (const [threadId, items] of byThread) {
      // How many times this thread already redid the same target. A repeated
      // correction is a thread going in circles, which says less about a
      // durable HARNESS fix than one clean correction does.
      const repeats = new Map<string, number>();
      for (let index = 1; index < items.length - 1; index += 1) {
        const user = items[index];
        if (!user || user.kind !== USER_KIND) continue;

        // What the agent had already touched BEFORE the user spoke.
        const earlier = new Set(
          items
            .slice(0, index)
            .filter((item) => item.kind && REDO_KINDS.has(item.kind))
            .map((item) => item.path ?? item.kind ?? ""),
        );
        const redo = items
          .slice(index + 1, index + 8)
          .find(
            (item) =>
              item.kind !== null &&
              REDO_KINDS.has(item.kind) &&
              earlier.has(item.path ?? item.kind ?? ""),
          );
        if (!redo) continue;

        const target = redo.path ?? redo.kind ?? "";
        const seen = repeats.get(target) ?? 0;
        repeats.set(target, seen + 1);
        out.push(
          correction(transcriptScanner, {
            causeClass: null,
            text:
              `a user turn was followed by the agent redoing ` +
              `${basename(target) || redo.kind || "the same call"}, which it had ` +
              `already done earlier in the thread`,
            runFolder: user.run_folder,
            threadId,
            at: user.started_at ?? ctx.now(),
            rowId: `${user.seq}`,
            confidenceDelta: -seen * 0.05,
          }),
        );
      }
    }
    return out;
  },
};

/** Every scanner, in precision order. `runScan` relies on that order. */
export const SCANNERS: readonly Scanner[] = [
  nudgeScanner,
  gateScanner,
  decisionScanner,
  reviewScanner,
  qaScanner,
  retroCandidateScanner,
  retroFindingScanner,
  obsSignalScanner,
  transcriptScanner,
];

/**
 * Run every scanner and report what each found.
 *
 * A scanner that throws costs its own source and nothing else: a malformed
 * ledger in one repo must not stop the other eight sources from being mined.
 */
export function scanAll(
  ctx: ScanContext,
  log?: { warn(message: string): void },
): { corrections: Correction[]; bySource: ScanCounts["bySource"] } {
  const corrections: Correction[] = [];
  const bySource: ScanCounts["bySource"] = {};
  for (const scanner of SCANNERS) {
    try {
      const found = scanner.scan(ctx);
      if (found.length > 0) bySource[scanner.source] = found.length;
      corrections.push(...found);
    } catch (error) {
      log?.warn(
        `[distillery] scanner ${scanner.source} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return { corrections, bySource };
}

/** Run folders the ledger knows about, newest first. */
export function knownRunFolders(db: Database): string[] {
  return db
    .prepare<[], { run_folder: string }>(
      `SELECT run_folder, MAX(last_seen_at) AS seen
         FROM obs_thread
        WHERE run_folder IS NOT NULL
        GROUP BY run_folder
        ORDER BY seen DESC`,
    )
    .all()
    .map((row) => row.run_folder)
    .filter((folder) => existsSync(folder));
}
