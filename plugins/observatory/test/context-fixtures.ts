// A throwaway project tree plus a throwaway home, so a context scan can be
// tested against real files without reading the machine's own.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export class TempTree {
  readonly root: string;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "observatory-ctx-"));
  }

  /** The project directory a scan is pointed at. */
  get cwd(): string {
    return this.ensure("project");
  }

  /** The fake home the global surfaces are read from. */
  get home(): string {
    return this.ensure("home");
  }

  ensure(relative: string): string {
    const path = join(this.root, relative);
    mkdirSync(path, { recursive: true });
    return path;
  }

  write(relative: string, content: string): string {
    const path = join(this.root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    return path;
  }

  skill(relative: string, name: string, description: string): string {
    return this.write(
      `${relative}/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n\nBody text that is not billed on every request.\n`,
    );
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
