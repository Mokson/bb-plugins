// The watch surfaces' typed view of `module-rpc.ts`, plus the one write path
// the module has.
//
// Reads share the spend pages' loading/absent/error rule verbatim. The write
// (`observatory_watch_settings_set`) is not a hook: it happens on a click, it
// returns the new settings, and the caller decides what to do with the note.
import { useCallback } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useModuleQuery, type ModuleQuery } from "./module-rpc.js";
import type {
  SteerResult,
  WatchSettings,
  watchContract,
} from "../../watch/contract.js";

export { isFixtureMode } from "./module-rpc.js";

/** The line every watch surface shows when the module's rpc is missing. */
export const WATCH_ABSENT_MESSAGE = "watch module not running";

export type WatchQuery<T> = ModuleQuery<T>;

type WatchMethod = Extract<keyof typeof watchContract, string>;

/**
 * Call one watch method and track its state. `nonce` re-runs the query; the
 * pages bump it when a realtime signal lands or a setting is written.
 */
export function useWatchQuery<T>(
  method: WatchMethod,
  input: Record<string, unknown>,
  fixture: () => T,
  nonce = 0,
): WatchQuery<T> {
  return useModuleQuery<T>(method, input, fixture, nonce);
}

/**
 * Steer or escalate one thread from the panel.
 *
 * Same shape as the settings write and for the same reason: both callers are
 * click handlers, and an unhandled rejection in one would leave the page
 * claiming an action the server refused. The confirmation line is the server's
 * `message`, never composed here — the CLI prints that same string, and two
 * surfaces inventing their own wording is how they start disagreeing about
 * what a refusal means.
 */
export function useWatchSteer(): (
  action: "steer" | "escalate",
  threadId: string,
) => Promise<string> {
  const rpc = useRpc();
  return useCallback(
    async (action, threadId) => {
      try {
        const result = (await (
          rpc.call as (
            method: string,
            input: Record<string, unknown>,
          ) => Promise<unknown>
        )(`observatory_watch_${action}`, { threadId })) as SteerResult;
        return result.message;
      } catch (error) {
        return error instanceof Error ? error.message : WATCH_ABSENT_MESSAGE;
      }
    },
    [rpc],
  );
}

/** What a settings write reports back to the page. */
export type WatchSettingsWrite =
  | { kind: "ok"; settings: WatchSettings }
  | { kind: "failed"; message: string };

/**
 * Write watch settings.
 *
 * Returns the result rather than throwing: every caller here is an event
 * handler, and an unhandled rejection in one would leave the page showing a
 * value the server never accepted.
 */
export function useWatchSettingsWrite(): (
  input: Record<string, unknown>,
) => Promise<WatchSettingsWrite> {
  const rpc = useRpc();
  return useCallback(
    async (input) => {
      try {
        const settings = (await (
          rpc.call as (
            method: string,
            input: Record<string, unknown>,
          ) => Promise<unknown>
        )("observatory_watch_settings_set", input)) as WatchSettings;
        return { kind: "ok", settings };
      } catch (error) {
        return {
          kind: "failed",
          message:
            error instanceof Error ? error.message : WATCH_ABSENT_MESSAGE,
        };
      }
    },
    [rpc],
  );
}
