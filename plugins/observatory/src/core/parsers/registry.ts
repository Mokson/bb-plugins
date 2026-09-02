// Which parser owns a path.
//
// Order matters only in that the first match wins; the predicates are
// disjoint by root directory, so the list is really a set. A path no parser
// claims is skipped by the indexer rather than guessed at.
import type { LogParser } from "./types.js";
import { claudeParser } from "./claude.js";
import { codexParser } from "./codex.js";
import { piParser, piBridgeParser } from "./pi.js";
import { ompParser } from "./omp.js";
import { cursorParser } from "./cursor.js";
import { opencodeParser } from "./opencode.js";

export const PARSERS: LogParser[] = [
  claudeParser,
  codexParser,
  piParser,
  piBridgeParser,
  ompParser,
  cursorParser,
  opencodeParser,
];

export function parserFor(
  path: string,
  parsers: readonly LogParser[] = PARSERS,
): LogParser | null {
  return parsers.find((parser) => parser.matches(path)) ?? null;
}
