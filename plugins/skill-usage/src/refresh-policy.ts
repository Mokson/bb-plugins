/**
 * When a refresh pass is worth running. Switching between the Project and All
 * scopes must not re-walk every thread: a pass costs one `events.list` call
 * per thread even when nothing has changed, because the SDK has no
 * cross-thread query to ask "what is new" in one go.
 */

/**
 * Passes closer together than this are skipped. Long enough that tab switching
 * is free, short enough that a rollup opened after real work still catches up.
 * Thread scope is unaffected: it reads events directly and stays live.
 */
export const REFRESH_COOLDOWN_MS = 60_000;

export function shouldRefresh(args: {
  running: boolean;
  lastRefreshAt: number | null;
  nowMs: number;
  rebuild: boolean;
}): boolean {
  // A rebuild is an explicit request, so it ignores the cooldown. It still
  // waits for a running pass rather than starting a second one.
  if (args.running) return false;
  if (args.rebuild) return true;
  if (args.lastRefreshAt === null) return true;
  return args.nowMs - args.lastRefreshAt >= REFRESH_COOLDOWN_MS;
}
