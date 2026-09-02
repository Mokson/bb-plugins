// The thread registry: bb's thread DTO turned into one `obs_thread` row.
//
// Everything expensive here is cached, because ingest asks for a thread on
// every drain and the answers barely move: the parent chain is immutable once
// set, and a run folder is a filesystem fact that only appears once.
//
// The root walk has a hard depth cap. A cycle in the parent chain should be
// impossible, but a registry that hangs would take ingest down with it, so the
// cap is the invariant and "unknown root" is an acceptable answer.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ThreadRow } from "./store.js";

/** Parent links walked before the registry gives up and keeps what it has. */
export const ROOT_WALK_DEPTH_CAP = 32;

/**
 * Deliver seat names. A seat may be tagged anywhere in a title, because bb
 * child threads spawned by the delegate skill carry the tier prefix while
 * deliver's own seats carry the seat name.
 */
export const DELIVER_SEATS = [
  "deliver-analyst",
  "deliver-auditor",
  "deliver-fixer",
  "deliver-implementer",
  "deliver-ops",
  "deliver-product-spec",
  "deliver-prototype",
  "deliver-qa",
  "deliver-retro",
  "deliver-reviewer",
  "deliver-shipper",
  "deliver-tech-spec",
] as const;

/** `[model:effort] rest of title` — the delegate skill's naming convention. */
const TIER_PREFIX = /^\s*\[([A-Za-z0-9._-]+:[A-Za-z0-9._-]+)\]\s*(.*)$/u;

export interface SeatAndTier {
  seat: string | null;
  tier_tag: string | null;
}

/** A seat name counts only where it stands as a whole word in the title. */
function mentionsSeat(title: string, seat: string): boolean {
  const isWordChar = (char: string | undefined): boolean =>
    char !== undefined && /[A-Za-z0-9-]/u.test(char);
  for (
    let index = title.indexOf(seat);
    index >= 0;
    index = title.indexOf(seat, index + 1)
  ) {
    if (
      !isWordChar(title[index - 1]) &&
      !isWordChar(title[index + seat.length])
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Split a thread title into the seat that ran it and the tier it ran at.
 *
 * A deliver seat name wins over the prefix remainder: `[son5:low]
 * deliver-qa row 3` is the QA seat at son5:low, not a seat called
 * "deliver-qa row 3".
 *
 * Two things this deliberately does NOT do. It does not substring-match, so
 * `deliver-qa-notes` is not the QA seat. And it does not fall back to the
 * title remainder: an ordinary chat is not a seat, and minting one from free
 * text is what fills the seat column with one-offs that never aggregate.
 */
export function parseSeatAndTier(title: string | null | undefined): SeatAndTier {
  if (!title) return { seat: null, tier_tag: null };
  const match = TIER_PREFIX.exec(title);
  const tier = match ? (match[1] as string) : null;
  const seat = DELIVER_SEATS.find((name) => mentionsSeat(title, name)) ?? null;
  return { seat, tier_tag: tier };
}

/**
 * The deliver run folder a thread is working in: the `docs/specs/<id>_<slug>/`
 * under `cwd` whose LEDGER.md was written most recently. The ledger is the
 * discriminator — an empty spec directory is not a run.
 *
 * Recency, not name order, is the tiebreak. A repo accumulates run folders,
 * and the alphabetically first one is whichever run happened to be numbered
 * lowest — so every thread in a repo with history got attributed to the same
 * ancient run.
 */
export function findRunFolder(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const specs = join(cwd, "docs", "specs");
  let entries: string[];
  try {
    entries = readdirSync(specs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  let newest: { folder: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    const folder = join(specs, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(join(folder, "LEDGER.md")).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mtimeMs > newest.mtimeMs) newest = { folder, mtimeMs };
  }
  return newest?.folder ?? null;
}

type ThreadsApi = BbPluginApi["sdk"]["threads"];
type ThreadDto = Awaited<ReturnType<ThreadsApi["get"]>>;

export interface ThreadRegistryOptions {
  threads: ThreadsApi;
  log?: Pick<BbPluginApi["log"], "warn">;
  /** Injected for tests; defaults to the real filesystem probe. */
  runFolder?: (cwd: string | null) => string | null;
  depthCap?: number;
}

export interface ResolvedThread {
  row: Partial<ThreadRow> & { thread_id: string };
  /** The DTO, so callers can read fields the ledger does not store. */
  dto: ThreadDto | null;
}

/**
 * Resolves and caches thread facts. One instance per plugin load; the caches
 * are bounded by the number of threads seen, which is the same order as the
 * ledger itself.
 */
export class ThreadRegistry {
  private readonly threads: ThreadsApi;
  private readonly log: Pick<BbPluginApi["log"], "warn"> | undefined;
  private readonly probeRunFolder: (cwd: string | null) => string | null;
  private readonly depthCap: number;
  private readonly dtoCache = new Map<string, ThreadDto>();
  private readonly lineage = new Map<
    string,
    { root: string; depth: number }
  >();
  private readonly runFolderCache = new Map<string, string | null>();

  constructor(options: ThreadRegistryOptions) {
    this.threads = options.threads;
    this.log = options.log;
    this.probeRunFolder = options.runFolder ?? findRunFolder;
    this.depthCap = options.depthCap ?? ROOT_WALK_DEPTH_CAP;
  }

  /** Drop cached DTOs so a renamed or re-parented thread is re-read. */
  invalidate(threadId?: string): void {
    if (threadId) {
      this.dtoCache.delete(threadId);
      this.lineage.delete(threadId);
      return;
    }
    this.dtoCache.clear();
    this.lineage.clear();
  }

  private async fetch(threadId: string): Promise<ThreadDto | null> {
    const cached = this.dtoCache.get(threadId);
    if (cached) return cached;
    try {
      const dto = await this.threads.get({
        threadId,
        include: "environment",
      });
      this.dtoCache.set(threadId, dto);
      return dto;
    } catch (error) {
      this.log?.warn(
        `[core] thread ${threadId} unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Walk parents to the root, capped. A chain longer than the cap, or one that
   * revisits a thread, stops at the last thread it could prove.
   */
  async lineageOf(
    threadId: string,
  ): Promise<{ root: string; depth: number; parent: string | null }> {
    const dto = await this.fetch(threadId);
    const parent = dto?.parentThreadId ?? null;
    if (!parent) {
      this.lineage.set(threadId, { root: threadId, depth: 0 });
      return { root: threadId, depth: 0, parent: null };
    }
    const cached = this.lineage.get(threadId);
    if (cached) return { ...cached, parent };

    const seen = new Set<string>([threadId]);
    let current = parent;
    let depth = 1;
    while (depth < this.depthCap) {
      if (seen.has(current)) break;
      seen.add(current);
      const known = this.lineage.get(current);
      if (known) {
        depth += known.depth;
        current = known.root;
        break;
      }
      const parentDto = await this.fetch(current);
      const next = parentDto?.parentThreadId ?? null;
      if (!next) break;
      current = next;
      depth += 1;
    }
    const result = { root: current, depth };
    this.lineage.set(threadId, result);
    return { ...result, parent };
  }

  private runFolderFor(cwd: string | null): string | null {
    if (!cwd) return null;
    const cached = this.runFolderCache.get(cwd);
    if (cached !== undefined) return cached;
    const folder = this.probeRunFolder(cwd);
    this.runFolderCache.set(cwd, folder);
    return folder;
  }

  /** The full ledger row for one thread. `dto` is null when bb refused. */
  async resolve(threadId: string): Promise<ResolvedThread> {
    const dto = await this.fetch(threadId);
    if (!dto) return { row: { thread_id: threadId }, dto: null };
    const { root, depth, parent } = await this.lineageOf(threadId);
    const environment = (dto as { environment?: { path?: string | null } })
      .environment;
    const cwd = environment?.path ?? null;
    const title = dto.title ?? dto.titleFallback ?? null;
    const { seat, tier_tag } = parseSeatAndTier(title);
    return {
      dto,
      row: {
        thread_id: threadId,
        project_id: dto.projectId ?? null,
        provider_id: dto.providerId ?? null,
        parent_thread_id: parent,
        root_thread_id: root,
        depth,
        title,
        seat,
        tier_tag,
        visibility: dto.visibility ?? null,
        origin: dto.originKind ?? null,
        run_folder: this.runFolderFor(cwd),
        cwd,
        created_at: new Date(dto.createdAt).toISOString(),
        status: dto.status ?? null,
      },
    };
  }
}
