// OMP sessions (`~/.omp/agent/sessions/**/*.jsonl`).
//
// Byte-for-byte the Pi format (verified against real files: same `session`
// header, same `message.usage` keys, same cost object), so this is a root and
// a provider tag rather than a parser. It stays a separate module because the
// provider id is what the pricing catalog and every rollup group by, and
// collapsing OMP into "pi" would make an OMP bill unattributable.
import { parsePiFamilyLines } from "./pi.js";
import type { LogParser } from "./types.js";

export const OMP_PROVIDER = "omp";

export const ompParser: LogParser = {
  provider: OMP_PROVIDER,
  matches: (path) =>
    path.endsWith(".jsonl") && path.includes("/.omp/agent/sessions/"),
  parseLines: (lines, ctx) => parsePiFamilyLines(OMP_PROVIDER, lines, ctx),
};
