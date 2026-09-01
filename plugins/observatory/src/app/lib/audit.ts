// The audit pages' two judgements, kept out of the page files.
//
// Both are pure and both are the kind of rule that is wrong quietly: a
// verdict that accuses a run of skipping verification when the ledger simply
// holds no command text, and a mute that never expires. They live here, free
// of the SDK app runtime, so a test can exercise them without a browser -
// the same reason `filters.ts` sits outside `pages/`.
import { UNKNOWN } from "./format.js";
import type { AuditVerification } from "../../audit/contract.js";

/** The mute durations offered, in days. No entry means no permanent mute. */
export const MUTE_DAYS = [1, 7, 30] as const;

export type MuteDays = (typeof MUTE_DAYS)[number];

/** The expiry a mute chosen now would carry. */
export function muteExpiry(now: Date, days: MuteDays): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Did this session verify anything?
 *
 * `textAvailable: false` is the normal case - core fingerprints command
 * arguments away - so the answer is "no" only when there was text to match
 * against. Anything else is unknown rather than an accusation.
 */
export function verificationVerdict(
  verification: AuditVerification,
): string {
  if (verification.verificationCommands > 0) return "yes";
  if (!verification.textAvailable) return UNKNOWN;
  return "no";
}
