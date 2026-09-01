// PRODUCT.md invariant 29: an unknown key fails the case. The PATH matters as
// much as the failure — a typo three levels down inside `assert.trace` must
// name itself, or the operator hunts a 50-line file by hand.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadCaseFile } from "../src/eval/cases.js";
import { makeGitFixture, caseYaml } from "./eval-fixtures.js";

const dir = mkdtempSync(join(tmpdir(), "observatory-eval-keys-"));
const fixture = makeGitFixture();

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  fixture.dispose();
});

function load(name: string, yaml: string) {
  const path = join(dir, `${name}.yaml`);
  writeFileSync(path, yaml);
  return loadCaseFile(path);
}

describe("an unknown key fails load with its path", () => {
  it("names a stray key at the root", () => {
    const result = load("root", `${caseYaml("root", fixture)}\nwhatever: 1\n`);
    expect(result.value).toBeNull();
    expect(result.error).toContain("unknown key");
    expect(result.error).toContain("<root>.whatever");
  });

  it("names a stray key nested inside fixture", () => {
    const yaml = caseYaml("nested", fixture).replace(
      "  base_branch: fixture/base",
      "  base_branch: fixture/base\n  branch: fixture/base",
    );
    const result = load("nested", yaml);
    expect(result.value).toBeNull();
    expect(result.error).toContain("fixture.branch");
  });

  it("names a stray key three levels down inside assert", () => {
    const yaml = caseYaml("deep", fixture).replace(
      "    sections_present: [runlog]",
      "    sections_present: [runlog]\n    sections: [runlog]",
    );
    const result = load("deep", yaml);
    expect(result.value).toBeNull();
    expect(result.error).toContain("assert.ledger.sections");
  });

  it("accepts the same case once the stray key is gone", () => {
    const result = load("clean", caseYaml("clean", fixture));
    expect(result.error).toBeNull();
    expect(result.value?.name).toBe("clean");
  });

  it("refuses a duplicate key rather than letting the last one win", () => {
    const yaml = `${caseYaml("dupe", fixture)}\ntrials: 5\n`;
    const result = load("dupe", yaml);
    expect(result.value).toBeNull();
    expect(result.error).toContain("duplicate key");
  });
});
