/**
 * The one icon-button surface this plugin draws: the row's hover actions, and
 * the new-thread and display-options controls on the first section header.
 *
 * It lives here rather than beside any one of them because a control that
 * highlights on hover and one that only shifts its text colour read as two
 * different kinds of thing. The header's controls had no background at all,
 * so they looked inert next to the row buttons directly beneath them.
 *
 * `cursor-pointer` is explicit: bb's own reset gives a `<button>` the default
 * arrow, and the row's anchor beneath these makes the miss hard to spot.
 */
export const CONTROL_BUTTON_CLASS = [
  "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded",
  "text-muted-foreground outline-none transition-colors",
  "hover:bg-accent hover:text-foreground",
  "focus-visible:ring-1 focus-visible:ring-ring",
].join(" ");
