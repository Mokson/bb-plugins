// Redaction. Every character distillery stores or sends passes through here.
//
// This is the module's only safety-critical file. Distillery reads ledgers,
// transcripts and review findings — text written by people and agents who had
// no reason to keep secrets out of it — and then both WRITES it to a database
// and SENDS it to a model. Either direction is an exfiltration path, so the
// rule is that `redact()` is the constructor for a stored preview: the store
// accepts a `Redacted` value and nothing else, so "we forgot to redact this
// one call site" is a type error rather than a leak.
//
// Rules run in a fixed order, strongest first: a secret that also contains an
// email must be masked as a secret, not partly unmasked by the email rule
// running first and consuming its tail.

/** Chars a stored preview may hold. Invariant 11. */
export const PREVIEW_MAX_CHARS = 1200;

/**
 * Rule ids, in application order. Stored as the keys of `redaction_counts`,
 * so renaming one orphans the counts on existing rows — append instead.
 */
export const REDACTION_RULES = [
  "secret",
  "email",
  "ip",
  "home-path",
  "tracker-id",
] as const;

export type RedactionRule = (typeof REDACTION_RULES)[number];

/** How many substitutions each rule made. Absent means zero. */
export type RedactionCounts = Partial<Record<RedactionRule, number>>;

/**
 * Text that has been through `redact`. The brand is unforgeable outside this
 * file, which is what lets the store and the drafting prompt demand it.
 */
export interface Redacted {
  readonly text: string;
  readonly counts: RedactionCounts;
  /** True when the source was longer than `PREVIEW_MAX_CHARS`. */
  readonly truncated: boolean;
  readonly __redacted: unique symbol;
}

interface Rule {
  id: RedactionRule;
  pattern: RegExp;
  /** The mask. A function so a rule can keep a harmless prefix. */
  mask(match: string, ...groups: string[]): string;
}

/**
 * Private IPv4 space, which is not a secret and is often the only useful part
 * of an evidence line ("the sandbox bound 127.0.0.1"). Masking it would cost
 * signal for no privacy gain.
 */
function isPrivateIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n > 255)) {
    return true; // not a real address; leave it alone
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

const RULES: readonly Rule[] = [
  {
    // Provider keys, VCS tokens, cloud ids, bearer headers, and any long
    // opaque hex or base64 run. The long-run patterns are last inside this
    // rule so a recognisable prefix wins and the mask stays informative.
    id: "secret",
    pattern: new RegExp(
      [
        // OpenAI-style and Anthropic-style keys.
        String.raw`sk-[A-Za-z0-9_\-]{16,}`,
        // GitHub personal, OAuth, server, refresh and app tokens.
        String.raw`gh[pousr]_[A-Za-z0-9]{20,}`,
        // Slack.
        String.raw`xox[abposr]-[A-Za-z0-9\-]{10,}`,
        // AWS access key id.
        String.raw`AKIA[0-9A-Z]{16}`,
        // An Authorization header value.
        String.raw`[Bb]earer\s+[A-Za-z0-9._\-~+/]{16,}=*`,
        // Bare long opaque runs: hex digests and base64 blobs.
        String.raw`\b[0-9a-fA-F]{32,}\b`,
        String.raw`\b[A-Za-z0-9+/]{40,}={0,2}\b`,
      ].join("|"),
      "g",
    ),
    mask: (match) => {
      const prefix = /^(sk-|gh[pousr]_|xox[abposr]-|AKIA)/.exec(match);
      return prefix ? `[redacted:${prefix[1]}…]` : "[redacted:secret]";
    },
  },
  {
    id: "email",
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    mask: () => "[redacted:email]",
  },
  {
    id: "ip",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    mask: (match) => (isPrivateIpv4(match) ? match : "[redacted:ip]"),
  },
  {
    // The home path itself is the disclosure: it carries the account name and
    // the private directory layout. The path AFTER the home root is the part
    // that identifies the repo and the file, and it is exactly what makes a
    // draft actionable, so it is kept.
    id: "home-path",
    pattern: /(?:\/Users|\/home)\/[A-Za-z0-9._\-]+/g,
    mask: () => "~",
  },
  {
    // Tracker ids tie a preview to a client and a private backlog. A cluster
    // keyed on a signature containing MKL-473 would also never merge with the
    // same failure seen under a different ticket.
    id: "tracker-id",
    pattern: /\b[A-Z]{2,6}-\d+\b|(?<=\s|^)#\d+\b/g,
    mask: () => "[redacted:id]",
  },
];

/**
 * Mask every rule and count the substitutions, then cap the result.
 *
 * The cap is applied AFTER masking, not before: truncating first could cut a
 * secret in half and leave the first 900 characters of it in the clear.
 */
export function redact(input: string): Redacted {
  const counts: RedactionCounts = {};
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match, ...args) => {
      const groups = args.filter((a): a is string => typeof a === "string");
      const masked = rule.mask(match, ...groups);
      // A rule may decline (the private-IP case), and a decline is not a
      // redaction: counting it would report privacy work that never happened.
      if (masked !== match) counts[rule.id] = (counts[rule.id] ?? 0) + 1;
      return masked;
    });
  }
  const truncated = text.length > PREVIEW_MAX_CHARS;
  return {
    text: truncated ? `${text.slice(0, PREVIEW_MAX_CHARS - 1)}…` : text,
    counts,
    truncated,
  } as Redacted;
}

/** The stored JSON for `corrections.redaction_counts`. */
export function serializeCounts(counts: RedactionCounts): string {
  return JSON.stringify(counts);
}

export function parseCounts(value: string | null): RedactionCounts {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as RedactionCounts)
      : {};
  } catch {
    return {};
  }
}

/**
 * True when `text` still carries anything a rule would have masked.
 *
 * Used by the store's assertion and by the test that spies on inserts. It
 * re-runs the rules rather than trusting the brand, because the brand only
 * proves `redact` was CALLED, not that it was called on this exact string.
 */
export function hasUnredacted(text: string): boolean {
  return redact(text).text !== text;
}
