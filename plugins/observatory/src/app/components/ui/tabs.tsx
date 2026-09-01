/* shadcn/ui-derived, vendored: this plugin owns this source.
 *
 * Hand-written rather than pulled from `@radix-ui/react-tabs`, for the same
 * reason `switch.tsx` is: the panel needs a controlled tablist whose panels are
 * rendered by the caller, and `role="tablist"` plus `aria-selected` on a native
 * button already carries that contract. A runtime dependency would buy roving
 * focus and nothing else this panel uses.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

const TabsContext = React.createContext<{
  value: string;
  onValueChange(next: string): void;
} | null>(null);

export function Tabs({
  value,
  onValueChange,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  value: string;
  onValueChange(next: string): void;
}) {
  const context = React.useMemo(() => ({ value, onValueChange }), [value, onValueChange]);
  return (
    <TabsContext.Provider value={context}>
      <div className={cn("flex flex-col", className)} {...props} />
    </TabsContext.Provider>
  );
}

export function TabsList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="tablist"
      className={cn("flex flex-wrap items-center gap-1 border-b border-border", className)}
      {...props}
    />
  );
}

export function TabsTrigger({
  value,
  className,
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value" | "type"> & { value: string }) {
  const context = React.useContext(TabsContext);
  const selected = context?.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={cn(
        // The selected tab is marked by a foreground underline sitting on the
        // list's own hairline, so switching tabs moves one pixel of ink rather
        // than repainting a pill.
        // The host document styles bare `button` elements, so the reset is
        // explicit: a tab is text plus one underline, nothing else.
        // `text-[11px]`, not Tailwind's `text-xs`: PRODUCT invariant 34 fixes
        // the type scale at 11/13/16/24, and `text-xs` renders 12px - the
        // three nodes that put a fourth size on the panel.
        "-mb-px inline-flex cursor-pointer items-center gap-2 rounded-none border-0 border-b-2 border-transparent bg-transparent px-3 py-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected && "border-b-foreground font-medium text-foreground",
        className,
      )}
      onClick={() => context?.onValueChange(value)}
      {...props}
    />
  );
}
