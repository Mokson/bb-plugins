// The nightly runs only when its inputs moved.
//
// The two inputs are the skill stack's HEAD and the case files. A tick where
// neither changed can only reproduce last night's answer at full price, so it
// skips. The case fingerprint hashes CONTENT rather than mtimes, because an
// editor that rewrites a file byte-identically would otherwise buy a suite.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashCasesDir, shouldRunNightly } from "../src/eval/nightly.js";
import { caseYaml, makeGitFixture, writeCases } from "./eval-fixtures.js";
import type { GitFixture } from "./eval-fixtures.js";

describe("the nightly eval skips when neither the stack nor the cases changed", () => {
  let fixture: GitFixture;
  let dir: string;
  beforeEach(() => {
    fixture = makeGitFixture();
    dir = writeCases(fixture.root, { "smoke": caseYaml("smoke", fixture) });
  });
  afterEach(() => fixture.dispose());

  it("skips an identical fingerprint and runs when the stack moved", () => {
    const before = { stackSha: "sha-1", casesHash: hashCasesDir(dir) };
    expect(shouldRunNightly({ ...before }, before)).toBe(false);
    expect(shouldRunNightly({ ...before, stackSha: "sha-2" }, before)).toBe(true);
  });

  it("runs when a case file's CONTENT changed, and not when only its mtime did", () => {
    const before = { stackSha: "sha-1", casesHash: hashCasesDir(dir) };
    const text = caseYaml("smoke", fixture);

    // Same bytes, new mtime: nothing that could change the answer moved.
    writeFileSync(join(dir, "smoke.yaml"), text);
    expect(shouldRunNightly({ stackSha: "sha-1", casesHash: hashCasesDir(dir) }, before)).toBe(
      false,
    );

    writeFileSync(join(dir, "smoke.yaml"), text.replace("trials: 1", "trials: 2"));
    expect(shouldRunNightly({ stackSha: "sha-1", casesHash: hashCasesDir(dir) }, before)).toBe(
      true,
    );
  });

  it("runs on the first tick, when there is no previous fingerprint", () => {
    expect(shouldRunNightly({ stackSha: "sha-1", casesHash: hashCasesDir(dir) }, null)).toBe(true);
    expect(
      shouldRunNightly({ stackSha: "sha-1", casesHash: hashCasesDir(dir) }, undefined),
    ).toBe(true);
  });

  it("hashes a missing cases directory rather than throwing", () => {
    expect(hashCasesDir(join(fixture.root, "nowhere"))).toHaveLength(64);
  });
});
