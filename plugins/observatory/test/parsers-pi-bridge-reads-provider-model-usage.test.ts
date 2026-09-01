import { describe, expect, it } from "vitest";
import { parsePiFamilyLines, sessionIdFromPath, PI_BRIDGE_PROVIDER } from "../src/core/parsers/pi.js";
import { ompParser, OMP_PROVIDER } from "../src/core/parsers/omp.js";
import {
  BRIDGE_SESSION,
  OMP_SESSION,
  PI_SESSION,
  fixtureLines,
  fixturePath,
} from "./log-fixtures.js";

// Pi, OMP and bb's pi-bridge share one format, and all three report their own
// cost. That logged figure outranks any catalog estimate, so losing it means
// re-guessing a number the provider already told us exactly.
describe("the Pi-family parser", () => {
  it("reads provider, model, the cache split and the logged cost from a bridge session", () => {
    const rows = parsePiFamilyLines(
      PI_BRIDGE_PROVIDER,
      fixtureLines(...BRIDGE_SESSION),
      { path: fixturePath(...BRIDGE_SESSION), startLine: 0 },
    );

    expect(rows.length).toBeGreaterThan(0);
    const [row] = rows;
    // bb's bridge names the file after the thread, not after a session line.
    expect(row.providerThreadId).toBe("thr_2dpba3tjy8");
    expect(row.model).toBeTruthy();
    expect(row.cacheRead).not.toBeNull();
    expect(row.cacheWrite).not.toBeNull();
    expect(row.loggedCostUsd).not.toBeNull();
    // User rows carry no usage and must not become priced turns.
    expect(rows.every((candidate) => candidate.output >= 0)).toBe(true);
  });

  it("takes a Pi session id from the file name, so a mid-file resume still attributes", () => {
    const path = fixturePath(...PI_SESSION);
    const all = fixtureLines(...PI_SESSION);

    const resumed = parsePiFamilyLines("pi", all.slice(3), { path, startLine: 3 });

    expect(sessionIdFromPath(path)).toBe(
      "01a00a8d-475e-7448-bf59-91c51906529b",
    );
    expect(resumed.length).toBeGreaterThan(0);
    expect(
      resumed.every(
        (row) => row.providerThreadId === "01a00a8d-475e-7448-bf59-91c51906529b",
      ),
    ).toBe(true);
    expect(resumed[0].line).toBeGreaterThanOrEqual(3);
  });

  it("tags OMP rows with their own provider rather than folding them into Pi", () => {
    const rows = ompParser.parseLines(fixtureLines(...OMP_SESSION), {
      path: fixturePath(...OMP_SESSION),
      startLine: 0,
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.provider === OMP_PROVIDER)).toBe(true);
  });
});
