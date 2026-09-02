// The nightly smoke decision.
//
// A nightly eval costs real money per tick, and most nights nothing that
// could change its answer has changed: the skill stack is the same commit and
// the case files are byte-identical. So the cron computes a fingerprint of
// exactly those two inputs and skips when it matches the last one it ran.
//
// The fingerprint deliberately covers the CASE FILES rather than their
// directory mtime, because an editor that rewrites a file with the same
// content would otherwise buy a full suite.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expandHome } from "./cases.js";

export interface NightlyFingerprint {
  /** `~/.agents` HEAD, or null when it is not a git checkout. */
  stackSha: string | null;
  /** sha256 over every case file's name and bytes, in name order. */
  casesHash: string;
}

export const NIGHTLY_KV_KEY = "eval_nightly_fingerprint";

/** Hash the cases directory. A missing directory hashes as empty, not as an error. */
export function hashCasesDir(dir: string): string {
  const root = expandHome(dir);
  const hash = createHash("sha256");
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => /\.ya?ml$/.test(name)).sort();
  } catch {
    return hash.update("<absent>").digest("hex");
  }
  for (const name of names) {
    hash.update(name);
    hash.update("\0");
    try {
      hash.update(readFileSync(join(root, name)));
    } catch {
      hash.update("<unreadable>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Run only when something that could change the answer moved. An unknown
 * previous fingerprint runs: the first nightly after an install must produce
 * a baseline rather than skip forever.
 */
export function shouldRunNightly(
  current: NightlyFingerprint,
  previous: NightlyFingerprint | null | undefined,
): boolean {
  if (previous === null || previous === undefined) return true;
  return (
    previous.stackSha !== current.stackSha || previous.casesHash !== current.casesHash
  );
}
