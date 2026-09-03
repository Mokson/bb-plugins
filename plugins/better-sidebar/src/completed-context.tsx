import { createContext, useContext, type ReactNode } from "react";

/**
 * B86: the mark-completed action, reachable from the row's two menus.
 *
 * A context rather than a prop: the action is called from `RowActions` and
 * `RowContextMenu`, both of which sit under `ThreadRow`, and neither the row
 * nor the list has any other use for it. Threading it through as a prop would
 * put a parameter on three components so that one leaf can call it.
 *
 * The default is a no-op, so a row rendered outside the list — a test harness,
 * a story — draws its menu instead of throwing.
 */
const CompletedActionsContext = createContext<{
  setCompleted: (threadId: string, completed: boolean) => void;
}>({ setCompleted: () => {} });

export function CompletedActionsProvider({
  setCompleted,
  children,
}: {
  setCompleted: (threadId: string, completed: boolean) => void;
  children: ReactNode;
}) {
  // The value object is rebuilt whenever `setCompleted` changes identity, which
  // it does on every write (it closes over the current entries). Memoizing it
  // would only defer the same re-render the new entries require anyway.
  return (
    <CompletedActionsContext.Provider value={{ setCompleted }}>
      {children}
    </CompletedActionsContext.Provider>
  );
}

export function useCompletedActions() {
  return useContext(CompletedActionsContext);
}
