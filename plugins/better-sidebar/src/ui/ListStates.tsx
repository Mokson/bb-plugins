import { Glyph } from "./Glyph";

/**
 * The four things the list can be other than a list of threads.
 *
 * `experimental_useSidebarThreads()` reports `loading | error | ready`, and a
 * blank sidebar is never an acceptable rendering of any of them: the user
 * cannot tell a slow load from a broken plugin from an empty account from a
 * search that missed. Each branch below therefore carries copy no other branch
 * carries, which is what keeps the four from quietly collapsing into one.
 */

const SKELETON_ROWS = 6;

/** `status: "loading"` — the shape of the list, before it has content. */
export function ListLoading() {
  return (
    <div className="flex flex-col py-1" aria-busy="true" aria-label="Loading threads">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        // B54.1: one 28px line each, so the list does not resize as it loads.
        <div key={index} data-testid="thread-skeleton" className="flex h-7 items-center px-2">
          <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

/**
 * `status: "error"`. The SDK exposes no refetch, so the retry affordance
 * remounts the subtree that holds the subscription — the only re-request a
 * plugin can make.
 */
export function ListError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Glyph name="triangle-alert" className="size-4 shrink-0" />
        Threads could not be loaded.
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
      >
        Try again
      </button>
    </div>
  );
}

/** `status: "ready"` with nothing to show and no search running. */
export function ListEmpty() {
  return (
    <div className="flex flex-col gap-1 p-4 text-sm text-muted-foreground">
      <span className="font-medium text-foreground">No threads yet.</span>
      <span>Start one with the New thread button above.</span>
    </div>
  );
}

/** `status: "ready"` with a search that matched nothing — never the same as empty. */
export function ListNoMatches({ query }: { query: string }) {
  return (
    <div className="flex flex-col gap-1 p-4 text-sm text-muted-foreground">
      <span className="font-medium text-foreground">
        No threads match “{query}”.
      </span>
      <span>Clear the search to see every thread.</span>
    </div>
  );
}
