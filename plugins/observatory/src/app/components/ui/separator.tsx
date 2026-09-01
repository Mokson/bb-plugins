/* shadcn/ui-derived, vendored: this plugin owns this source.
 *
 * Hand-written rather than pulled from `@radix-ui/react-separator`: the whole
 * component is one decorative rule, and `role="none"` on a div is the entire
 * accessibility contract for a rule that carries no meaning.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

export function Separator({
  className,
  orientation = "horizontal",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical" }) {
  return (
    <div
      role="none"
      className={cn(
        "shrink-0 bg-border",
        orientation === "vertical" ? "h-6 w-px" : "h-px w-full",
        className,
      )}
      {...props}
    />
  );
}
