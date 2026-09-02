// Every eval page's one data hook.
//
// The mechanics are the panel's shared ones: fixture mode, `unknown_method`
// read as `absent` rather than as a failure, and a cancelled effect that never
// sets state. Those rules are not eval-specific, so this file narrows the
// shared hook to the eval contract's method names instead of copying ninety
// lines of state machine that would then drift.
import { useModuleQuery, type ModuleQuery } from "./module-rpc.js";
import type { evalContract } from "../../eval/contract.js";

/** The line every eval page shows when the module's rpc is not registered. */
export const EVAL_ABSENT_MESSAGE = "eval module not running";

/** The four states an eval read can be in. Same shape as any module read. */
export type EvalQuery<T> = ModuleQuery<T>;

type EvalMethod = Extract<keyof typeof evalContract, string>;

/**
 * Call one eval read and track its state. `input` may be built inline: the
 * wrapped hook keys its effect on the serialised value, not on identity.
 */
export function useEvalQuery<T>(
  method: EvalMethod,
  input: Record<string, unknown>,
  fixture: () => T,
  nonce = 0,
): EvalQuery<T> {
  return useModuleQuery<T>(method, input, fixture, nonce);
}
