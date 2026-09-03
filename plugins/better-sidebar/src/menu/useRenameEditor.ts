import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { experimental_useSidebarThreadActions as useSidebarThreadActions } from "@get-bb/plugin-sdk/app";
import { fireAndForget } from "./row-menu-items";

/** Titles longer than this are truncated on commit, not rejected. */
const MAX_RENAME_LENGTH = 200;

/**
 * The handle `ThreadRow` renders and `RowContextMenu` starts (B46).
 *
 * `actions.rename` is silent by design — it takes a finished title and shows
 * no host dialog — so the menu cannot call it. The rename item calls `start()`
 * instead, which puts the row into an inline editor; Enter and blur commit,
 * Escape cancels, and an empty, whitespace-only or unchanged title cancels
 * rather than committing.
 */
export interface RenameEditor {
  isRenaming: boolean;
  inputProps: {
    value: string;
    autoFocus: true;
    "aria-label": string;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
    onBlur: () => void;
  };
  /** Opens the editor, seeded with the row's current title. */
  start: (initialTitle?: string) => void;
  cancel: () => void;
}

export function useRenameEditor(threadId: string): RenameEditor {
  const actions = useSidebarThreadActions();
  const [isRenaming, setIsRenaming] = useState(false);
  const [value, setValue] = useState("");
  // The title the editor opened with, so an unchanged commit is a no-op.
  const initialRef = useRef("");
  // Escape closes the editor and the browser then fires blur on the same node.
  // A ref, not `isRenaming`, decides: it is already false by the time blur runs.
  const activeRef = useRef(false);

  const start = useCallback((initialTitle = "") => {
    initialRef.current = initialTitle;
    activeRef.current = true;
    setValue(initialTitle);
    setIsRenaming(true);
  }, []);

  const cancel = useCallback(() => {
    activeRef.current = false;
    setIsRenaming(false);
    setValue("");
  }, []);

  const commit = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setIsRenaming(false);
    const title = value.trim().slice(0, MAX_RENAME_LENGTH);
    setValue("");
    if (title === "" || title === initialRef.current.trim().slice(0, MAX_RENAME_LENGTH)) return;
    fireAndForget(actions.rename(threadId, title), "rename");
  }, [actions, threadId, value]);

  return {
    isRenaming,
    inputProps: {
      value,
      autoFocus: true,
      "aria-label": "Rename thread",
      onChange: (event) => setValue(event.target.value),
      onKeyDown: (event) => {
        if (event.key !== "Enter" && event.key !== "Escape") return;
        // The row is inside the host's list: keep both keys off its handlers.
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter") commit();
        else cancel();
      },
      onBlur: () => commit(),
    },
    start,
    cancel,
  };
}
