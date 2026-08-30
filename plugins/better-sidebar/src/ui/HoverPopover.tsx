import * as HoverCard from "@radix-ui/react-hover-card";
import type { ReactNode } from "react";
import { usePortalScopeProps } from "../lib/portal-scope";

/**
 * Controlled Radix hover card. It owns no timing of its own — the caller
 * drives `open` from its own hover-intent state machine.
 */
export function HoverPopover({
  open,
  onOpenChange,
  trigger,
  children,
  side,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const portalScopeProps = usePortalScopeProps();
  return (
    <HoverCard.Root open={open} onOpenChange={onOpenChange}>
      <HoverCard.Trigger asChild>{trigger}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content side={side} {...portalScopeProps}>
          {children}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
