// The pieces the watch surfaces share: the frame that decides what a page
// shows before its data arrives, the row action buttons, the filter box and
// the `?` sheet.
//
// Density contract (PRODUCT invariant 34): sizes 11, 13, 16, and 24 for at
// most four hero numbers; weights 400 and 600; 24px rows; hairlines, never
// boxes; radii at most 4px; no emojis; no colour carries meaning, so an
// uppercase word is the only emphasis a marker gets.
import { Heading, Hero, QueryFrame } from "@/components/spend-common";
import { KEY_HELP } from "@/lib/keys";
import { LADDER_TOOLTIP, isActionEnabled } from "@/lib/inbox";
import type { InboxAction } from "../../watch/contract.js";

// The heading, the hero number and the pre-data frame are the density contract
// itself, so they come from `spend-common` rather than being written again
// here: two copies of "what a hero number looks like", or of what a page shows
// before its data arrives, is exactly how a contract stops being one. The
// frame's absent line is derived from the method's module name, so a watch-only
// copy of it would be a second answer free to drift from the first.
export { Heading, Hero, QueryFrame };

/**
 * One row's actions.
 *
 * The ladder rungs render disabled with their tooltip rather than being
 * hidden: a reader who can see the rung exists learns the shape of the tool,
 * and buttons that appear in phase 3 would move every other control sideways.
 */
export function RowActions({
  actions,
  onRun,
  label,
}: {
  actions: readonly InboxAction[];
  onRun: (action: InboxAction) => void;
  label: string;
}) {
  return (
    <span className="flex gap-2">
      {actions.map((action) => {
        const enabled = isActionEnabled(action);
        return (
          <button
            key={action}
            type="button"
            disabled={!enabled}
            title={enabled ? undefined : LADDER_TOOLTIP}
            aria-label={`${action} ${label}`}
            className="underline underline-offset-2 disabled:no-underline disabled:opacity-50"
            onClick={() => onRun(action)}
          >
            {action}
          </button>
        );
      })}
    </span>
  );
}

/** The filter box. `/` focuses it; Escape leaves it. */
export function FilterBox({
  value,
  onChange,
  inputRef,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  placeholder: string;
}) {
  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      aria-label="Filter"
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="h-6 w-64 rounded-[4px] border-b border-border bg-transparent px-1 text-[13px] outline-none placeholder:text-muted-foreground"
    />
  );
}

/**
 * The `?` sheet, rendered from the same table the resolver reads, and the one
 * line that tells the reader the sheet exists. Both live here so a page cannot
 * ship the shortcuts without the way to discover them.
 */
export function KeyHelp({ open }: { open: boolean }) {
  if (!open) {
    return <p className="text-[11px] text-muted-foreground">? for keys</p>;
  }
  return (
    <table
      className="w-64 text-[11px] text-muted-foreground"
      aria-label="Keyboard shortcuts"
    >
      <tbody>
        {KEY_HELP.map((entry) => (
          <tr key={entry.keys} className="border-t border-border">
            <td className="h-6 w-16 py-0 font-semibold">{entry.keys}</td>
            <td className="h-6 py-0">{entry.does}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
