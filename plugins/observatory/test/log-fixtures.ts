// Where the redacted provider-log fixtures live, and how to read one.
//
// Every fixture is the LAST lines of a real session file on a real machine,
// with each message string replaced by "<redacted>" and every path by
// "/redacted". The usage numbers, model ids, timestamps, request ids,
// `isSidechain` flags and skill attributions are untouched, because those are
// exactly what the parsers exist to read: a hand-written fixture would only
// prove the parsers agree with my idea of the format.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "logs",
);

export function fixturePath(...segments: string[]): string {
  return join(FIXTURE_ROOT, ...segments);
}

export function fixtureLines(...segments: string[]): string[] {
  return readFileSync(fixturePath(...segments), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

export const CLAUDE_SESSION = ["claude", "session.jsonl"] as const;
export const CLAUDE_SIDECHAIN = ["claude", "sidechain.jsonl"] as const;
export const PI_SESSION = [
  "pi",
  "2026-08-16T12-30-26-142Z_01a00a8d-475e-7448-bf59-91c51906529b.jsonl",
] as const;
export const OMP_SESSION = [
  "omp",
  "2026-08-14T10-40-08-399Z_019fffdb-94cf-7000-a25b-5a7081527365.jsonl",
] as const;
export const BRIDGE_SESSION = ["bb-pi-bridge", "thr_2dpba3tjy8.jsonl"] as const;
export const CODEX_SESSION = [
  "codex",
  "rollout-2026-08-29T07-39-35-01a04c3e.jsonl",
] as const;
