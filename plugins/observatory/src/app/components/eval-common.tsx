// The chrome the two eval pages share.
//
// Density contract (PRODUCT invariant 34), same as the spend surfaces: sizes
// 11, 13, 16, and 24 for at most four hero numbers; weights 400 and 600; 24px
// rows; hairlines, never boxes; numerics right-aligned with tabular figures
// and the unit in the header. Nothing here carries colour as meaning, so a
// verdict is a word - PASS, WARN, FAIL, N-A - and reads the same in a
// screenshot as it does on screen.
import type { ReactNode } from "react";
import { PageSkeleton } from "@/components/spend-common";
import { type EvalQuery } from "@/lib/eval-rpc";

/**
 * The hero row. Wraps by width rather than by a fixed column count, so four
 * numbers in a narrow nav panel stack instead of shrinking to unreadable.
 */
export function HeroRow({ children }: { children: ReactNode }) {
  return (
    <div
      className="grid gap-6"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}
    >
      {children}
    </div>
  );
}

/**
 * What an eval page renders before its data arrives.
 *
 * `absent` keeps the skeleton and adds one line: the eval module can be turned
 * off in settings, and a page that rendered an empty table instead would read
 * as "no cases" - a measurement the plugin never took.
 */
export function EvalFrame<T>({
  query,
  children,
}: {
  query: EvalQuery<T>;
  children: (data: T) => ReactNode;
}) {
  if (query.kind === "loading") return <PageSkeleton />;
  if (query.kind === "absent") {
    return (
      <div className="flex flex-col gap-3">
        <PageSkeleton />
        {/* The hook derives this line from the method's own module, so the
            frame does not keep a second copy of the sentence. */}
        <p className="text-[11px] text-muted-foreground">{query.message}</p>
      </div>
    );
  }
  if (query.kind === "error") {
    return <p className="text-[13px] text-muted-foreground">{query.message}</p>;
  }
  return <>{children(query.data)}</>;
}

/** A left-aligned body cell on a 24px row. */
export function Cell({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <td className="h-6 px-2 py-0" title={title}>
      {children}
    </td>
  );
}

/** A verdict word. A word, not a colour: the page has no colour hierarchy. */
export function Verdict({ children }: { children: ReactNode }) {
  return (
    <td className="h-6 whitespace-nowrap px-2 py-0 font-semibold">{children}</td>
  );
}

/** An 11px key/value meta line, one pair per entry. Unknowns read `--`. */
export function MetaLine({
  entries,
}: {
  entries: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      {entries.map(([label, value]) => (
        <span key={label}>
          {label} <span className="tabular-nums">{value}</span>
        </span>
      ))}
    </p>
  );
}

/** A link that navigates inside the panel. Underline, never a button chrome. */
export function RowLink({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="truncate text-left underline underline-offset-2"
      onClick={onClick}
    >
      {label}
    </button>
  );
}
