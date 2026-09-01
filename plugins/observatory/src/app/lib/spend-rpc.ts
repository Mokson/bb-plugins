// The spend pages' typed view of `module-rpc.ts`.
//
// The loading/absent/error rule lives once, in `module-rpc.ts`, because the
// watch surfaces need exactly the same rule; all this file adds is the spend
// contract's method names and the line to show when the spend handlers are not
// registered.
import { useModuleQuery, type ModuleQuery } from "./module-rpc.js";
import type { spendContract } from "../../spend/contract.js";

export { isFixtureMode } from "./module-rpc.js";

/** The line every page shows when the module's rpc is not registered. */
export const ABSENT_MESSAGE = "spend module not running";

export type SpendQuery<T> = ModuleQuery<T>;

type SpendMethod = Extract<keyof typeof spendContract, string>;

/** Call one spend method and track its state. */
export function useSpendQuery<T>(
  method: SpendMethod,
  input: Record<string, unknown>,
  fixture: () => T,
): SpendQuery<T> {
  return useModuleQuery<T>(method, input, fixture);
}
