// The context audit: what the prefix of every request in this project is made
// of, and which parts of it are paid for twice or never read.
//
// The composition bar is the only chart here and one of exactly three in the
// plugin (PRODUCT invariant 34). It exists because composition is read as a
// proportion first - which surface owns the prefix - and a four-row table
// cannot show that at a glance. Everything else is a table.
//
// Every token number on this page is a model of the prefix, never a count, so
// every one of them carries the superscript mark and the page carries the one
// footnote that names the calibration behind it.
import type { ReactNode } from "react";
import {
  EstimateFootnote,
  Heading,
  Hero,
  HeroRow,
  Num,
  NumHead,
  QueryFrame,
  TextHead,
} from "@/components/spend-common";
import {
  formatCount,
  formatBytes,
  formatShare,
  formatTokens,
  UNKNOWN,
} from "@/lib/format";
import { readThreadFilter } from "@/lib/filters";
import { useModuleQuery } from "@/lib/module-rpc";
import {
  fixtureContextThread,
  fixtureContextView,
} from "@/fixtures/context";
import type {
  ContextComposition,
  ContextThreadView,
  ContextView,
} from "../../context/contract.js";

/**
 * One horizontal bar, one segment per surface, hairline separators between
 * segments and the labels beneath rather than inside: a segment can be 3% wide
 * and a label inside it would be clipped exactly when it matters most.
 */
function CompositionBar({
  composition,
}: {
  composition: readonly ContextComposition[];
}) {
  const present = composition.filter((entry) => entry.share > 0);
  if (present.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex h-6 w-full overflow-hidden rounded-[2px] border border-border"
        role="img"
        aria-label={`Prefix composition: ${present
          .map((entry) => `${entry.surface} ${formatShare(entry.share)}`)
          .join(", ")}`}
      >
        {present.map((entry, index) => (
          <div
            key={entry.surface}
            className={
              index === 0
                ? "bg-foreground/60"
                : "border-l border-background bg-foreground/60"
            }
            style={{
              width: `${entry.share * 100}%`,
              opacity: 1 - index * 0.18,
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {present.map((entry) => (
          <span key={entry.surface} className="tabular-nums">
            {entry.surface} {formatShare(entry.share)}{" "}
            {formatTokens(entry.estTokens, true)}
          </span>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function BlockTable({ view }: { view: ContextView }) {
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <TextHead>surface</TextHead>
          <TextHead>block</TextHead>
          <TextHead>path</TextHead>
          <TextHead>kind</TextHead>
          <NumHead>est tok</NumHead>
          <NumHead>share</NumHead>
        </tr>
      </thead>
      <tbody>
        {view.blocks.map((block) => (
          <tr key={block.hash} className="border-t border-border">
            <td className="h-6 px-2 py-0">{block.surface}</td>
            <td className="h-6 max-w-[220px] truncate px-2 py-0">
              {block.name}
            </td>
            <td
              className="h-6 max-w-[280px] truncate px-2 py-0 text-muted-foreground"
              title={block.path ?? undefined}
            >
              {block.path ?? UNKNOWN}
            </td>
            <td className="h-6 px-2 py-0 text-muted-foreground">
              {block.dead
                ? "unused"
                : block.duplicateOf === null
                  ? "unique"
                  : `duplicate of ${block.duplicateOf}`}
            </td>
            <Num>{formatTokens(block.estTokens, true)}</Num>
            <Num>
              {formatShare(
                view.snapshot.totalEstTokens > 0
                  ? block.estTokens / view.snapshot.totalEstTokens
                  : null,
              )}
            </Num>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DuplicateTable({ view }: { view: ContextView }) {
  if (view.duplicates.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        no pair overlaps past the threshold
      </p>
    );
  }
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <TextHead>pair</TextHead>
          <NumHead>overlap</NumHead>
          <NumHead>recoverable tok</NumHead>
        </tr>
      </thead>
      <tbody>
        {view.duplicates.map((pair) => (
          <tr key={`${pair.a}|${pair.b}`} className="border-t border-border">
            <td className="h-6 px-2 py-0">
              {pair.a} and {pair.b}
            </td>
            <Num>{formatShare(pair.overlap)}</Num>
            <Num>{formatTokens(pair.recoverableTokens, true)}</Num>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DeadSkillTable({ view }: { view: ContextView }) {
  if (view.dead.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        every skill in the prefix was named by a session
      </p>
    );
  }
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <TextHead>skill</TextHead>
          <TextHead>path</TextHead>
          <NumHead>bytes saved</NumHead>
        </tr>
      </thead>
      <tbody>
        {view.dead.map((skill) => (
          <tr key={skill.name} className="border-t border-border">
            <td className="h-6 px-2 py-0">{skill.name}</td>
            <td
              className="h-6 max-w-[320px] truncate px-2 py-0 text-muted-foreground"
              title={skill.path ?? undefined}
            >
              {skill.path ?? UNKNOWN}
            </td>
            <Num>{formatBytes(skill.bytes)}</Num>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The thread's own window, when the page was opened with `?thread=`. The
 * prefix above is the same for every thread in the project; this is the part
 * that is not, and the compaction estimate is what a compaction would free.
 */
function ThreadWindow({ threadId }: { threadId: string }) {
  const query = useModuleQuery<ContextThreadView>(
    "observatory_context_thread",
    { threadId },
    fixtureContextThread,
  );

  return (
    <QueryFrame query={query}>
      {(thread) => (
        <Section title={`Thread ${thread.threadId}`}>
          <table className="w-full text-[13px]">
            <tbody>
              <tr className="border-t border-border">
                <td className="h-6 px-2 py-0 text-muted-foreground">
                  window used tok
                </td>
                <Num>{formatTokens(thread.contextUsed)}</Num>
                <Num>of {formatTokens(thread.contextWindow)}</Num>
              </tr>
              <tr className="border-t border-border">
                <td className="h-6 px-2 py-0 text-muted-foreground">
                  history share
                </td>
                <Num>{formatShare(thread.historyShare)}</Num>
                <td className="h-6 px-2 py-0" />
              </tr>
              <tr className="border-t border-border">
                <td className="h-6 px-2 py-0 text-muted-foreground">
                  tool result share
                </td>
                <Num>{formatShare(thread.toolResultShare)}</Num>
                <td className="h-6 px-2 py-0" />
              </tr>
            </tbody>
          </table>
          <p className="text-[11px] text-muted-foreground">
            compaction would free about{" "}
            <span className="tabular-nums">
              {formatTokens(thread.compactionEstimateTokens, true)}
            </span>{" "}
            tokens
          </p>
        </Section>
      )}
    </QueryFrame>
  );
}

/** The calibration behind every estimated number on the page, in one line. */
function CalibrationFootnote({ view }: { view: ContextView }) {
  return (
    <p className="text-[11px] text-muted-foreground">
      calibration source {view.snapshot.provider ?? UNKNOWN} cache write, factor{" "}
      <span className="tabular-nums">
        {view.snapshot.calibrationFactor === null
          ? UNKNOWN
          : view.snapshot.calibrationFactor.toFixed(3)}
      </span>
      , last error{" "}
      <span className="tabular-nums">
        {formatShare(view.snapshot.calibrationError)}
      </span>
    </p>
  );
}

export function ContextAudit() {
  const threadId =
    typeof window === "undefined"
      ? null
      : readThreadFilter(window.location.search);
  const query = useModuleQuery<ContextView>(
    "observatory_context_snapshot",
    {},
    fixtureContextView,
  );

  return (
    <section className="flex flex-col gap-3 py-4">
      <Heading>Context</Heading>
      <QueryFrame query={query}>
        {(view) => (
          <>
            <HeroRow>
              <Hero
                label="prefix est tok"
                value={formatTokens(view.snapshot.totalEstTokens, true)}
              />
              <Hero label="blocks" value={formatCount(view.blocks.length)} />
              <Hero
                label="recoverable est tok"
                value={formatTokens(
                  view.duplicates.reduce(
                    (total, pair) => total + pair.recoverableTokens,
                    0,
                  ),
                  true,
                )}
              />
              <Hero
                label="unused skill bytes"
                value={formatBytes(
                  view.dead.reduce((total, skill) => total + skill.bytes, 0),
                )}
              />
            </HeroRow>
            <p className="text-[11px] text-muted-foreground">
              {view.snapshot.cwd}
            </p>
            <CompositionBar composition={view.composition} />
            <Section title="Blocks">
              <BlockTable view={view} />
            </Section>
            <Section title="Duplicates">
              <DuplicateTable view={view} />
            </Section>
            <Section title="Unused skills">
              <DeadSkillTable view={view} />
            </Section>
            {threadId === null ? null : <ThreadWindow threadId={threadId} />}
            <EstimateFootnote show />
            <CalibrationFootnote view={view} />
          </>
        )}
      </QueryFrame>
    </section>
  );
}

/** The same page as a thread tab, with the thread section always present. */
export function ThreadContext({ threadId }: { threadId: string }) {
  return (
    <section className="flex flex-col gap-3 py-4">
      <Heading>Context</Heading>
      <ThreadWindow threadId={threadId} />
    </section>
  );
}
