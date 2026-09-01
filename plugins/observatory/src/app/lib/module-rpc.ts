// Every panel page's one data hook, and the rule for a server that is not
// there yet.
//
// The plugin ships module by module: these pages and the rpc handlers behind
// them land separately. Until a handler exists bb answers `unknown_method`,
// and the honest render for that is the page's own skeleton plus one line -
// never a zero, never a dash pretending to be a measurement. `kind: "absent"`
// is that state, kept distinct from `kind: "error"` so a real handler failure
// still reads as a failure. The absent line names the module the method
// belongs to, so a reader of the context page is not told about spend.
import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { spendContract } from "../../spend/contract.js";
import type { contextContract } from "../../context/contract.js";
import type { auditContract } from "../../audit/contract.js";

export type ModuleQuery<T> =
  | { kind: "loading" }
  | { kind: "absent"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: T };

type ModuleMethod = Extract<
  | keyof typeof spendContract
  | keyof typeof contextContract
  | keyof typeof auditContract,
  string
>;

/**
 * The line a page shows when its module's rpc is not registered.
 *
 * Method names are `observatory_<module>_<verb>` by construction, so the
 * module is readable off the wire name and no page has to repeat it.
 */
export function absentMessage(method: string): string {
  const module = method.split("_")[1] ?? "observatory";
  return `${module} module not running`;
}

function isUnknownMethod(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "unknown_method"
  );
}

/**
 * True when the panel was opened with `?fixture=1`.
 *
 * A development affordance for rendering the pages before the server half
 * exists. The fixture data is deliberately, visibly synthetic (`thr_fixture_*`)
 * so a screenshot of it can never be mistaken for a real bill.
 */
export function isFixtureMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("fixture") === "1";
}

/**
 * Call one module method and track its state.
 *
 * `input` is re-serialised into the dependency key rather than compared by
 * reference, so a caller may build it inline without spinning the effect.
 */
export function useModuleQuery<T>(
  method: ModuleMethod,
  input: Record<string, unknown>,
  fixture: () => T,
): ModuleQuery<T> {
  const rpc = useRpc<typeof spendContract>();
  const [state, setState] = useState<ModuleQuery<T>>({ kind: "loading" });
  const inputKey = JSON.stringify(input);

  // Fixture mode never touches the network: the page must render identically
  // whether or not a server is listening.
  const fixtureData = useMemo(
    () => (isFixtureMode() ? fixture() : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inputKey],
  );

  useEffect(() => {
    if (fixtureData !== null) {
      setState({ kind: "ready", data: fixtureData });
      return;
    }

    let cancelled = false;
    setState({ kind: "loading" });

    void (async () => {
      try {
        // The contract's per-method input types are erased at this seam; the
        // schema on the server is the check that matters.
        const data = (await (
          rpc.call as (
            method: string,
            input: Record<string, unknown>,
          ) => Promise<unknown>
        )(method, JSON.parse(inputKey) as Record<string, unknown>)) as T;
        if (cancelled) return;
        setState({ kind: "ready", data });
      } catch (error) {
        if (cancelled) return;
        if (isUnknownMethod(error)) {
          setState({ kind: "absent", message: absentMessage(method) });
          return;
        }
        setState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Cannot reach the Observatory plugin.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rpc, method, inputKey, fixtureData]);

  return state;
}

/**
 * Post one module method as a user action rather than a page load.
 *
 * Exports and mutations run on click, so they do not belong in the effect
 * above. They share this one path so a failing action always surfaces as the
 * same one-line message the pages already render, never as a silent no-op or
 * an empty download.
 */
export async function callModule<T>(
  method: ModuleMethod,
  input: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`/api/v1/plugins/observatory/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  const payload = (await response.json()) as {
    ok?: boolean;
    result?: T;
    error?: { message?: string };
  };
  if (!response.ok || payload.ok !== true || payload.result === undefined) {
    throw new Error(payload.error?.message ?? absentMessage(method));
  }
  return payload.result;
}
