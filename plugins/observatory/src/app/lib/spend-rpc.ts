// Every spend page's one data hook, and the rule for a server that is not
// there yet.
//
// The spend module ships in two halves that land separately: these pages and
// the rpc handlers behind them. Until the handlers exist bb answers
// `unknown_method`, and the honest render for that is the page's own skeleton
// plus one line - never a zero, never a dash pretending to be a measurement.
// `kind: "absent"` is that state, kept distinct from `kind: "error"` so a real
// handler failure still reads as a failure.
import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { spendContract } from "../../spend/contract.js";

/** The line every page shows when the module's rpc is not registered. */
export const ABSENT_MESSAGE = "spend module not running";

export type SpendQuery<T> =
  | { kind: "loading" }
  | { kind: "absent" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: T };

type SpendMethod = Extract<keyof typeof spendContract, string>;

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
 * Call one spend method and track its state.
 *
 * `input` is re-serialised into the dependency key rather than compared by
 * reference, so a caller may build it inline without spinning the effect.
 */
export function useSpendQuery<T>(
  method: SpendMethod,
  input: Record<string, unknown>,
  fixture: () => T,
): SpendQuery<T> {
  const rpc = useRpc<typeof spendContract>();
  const [state, setState] = useState<SpendQuery<T>>({ kind: "loading" });
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
          setState({ kind: "absent" });
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
