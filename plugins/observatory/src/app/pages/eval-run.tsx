// One eval run: its header, a row per trial, and what the gate compares.
//
// A failed assertion renders indented under its trial rather than in a column
// of its own: a case fails on one key out of a dozen, and the key plus its
// detail is the whole diagnosis. A case the run selected but never recorded
// keeps a row too, reading `--`, because "no result" is a failure the gate
// grades and an absent row would hide it.
//
// Baseline: `evalContract` on this branch exposes cases, runs and one run.
// There is no baseline read and no promote write, so the per-metric deltas
// cannot be computed here. The thresholds the gate would apply are stated,
// and promotion is named as the CLI-only action it is - PRODUCT invariant 5
// reserves that write for `bb observatory eval baseline promote`.
import { useCallback } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import {
  Heading,
  Hero,
  Num,
  NumHead,
  TextHead,
} from "@/components/spend-common";
import {
  Cell,
  EvalFrame,
  HeroRow,
  MetaLine,
  RowLink,
  Verdict,
} from "@/components/eval-common";
import {
  UNKNOWN,
  formatCount,
  formatDuration,
  formatTime,
  formatTokens,
  formatUsd,
} from "@/lib/format";
import { useEvalQuery } from "@/lib/eval-rpc";
import {
  elapsedMs,
  failedAssertions,
  readMetrics,
  runCaseOrder,
  totalCostUsd,
  verdictWord,
} from "@/lib/eval-view";
import { fixtureRun } from "@/fixtures/eval";
import { DRIFT } from "../../eval/gate.js";
import type { EvalCaseResultView, EvalRunView } from "../../eval/contract.js";
import { PANEL_PATH } from "./routes.js";

const PROMOTE_NOTE =
  "baseline promotion is CLI only: bb observatory eval baseline promote <run>";

/** The gate's drift ceilings, read from the gate itself so they cannot drift. */
const THRESHOLDS = `warn over baseline at tokens +${Math.round(
  DRIFT.tokens * 100,
)}%, cost +${Math.round(DRIFT.cost * 100)}%, wall +${Math.round(
  DRIFT.wall * 100,
)}%`;

/** Every trial of one case, or the one `--` row a silent case gets. */
function CaseBlock({
  name,
  trials,
}: {
  name: string;
  trials: readonly EvalCaseResultView[];
}) {
  if (trials.length === 0) {
    return (
      <tr className="border-t border-border">
        <Cell>{name}</Cell>
        <Num>{UNKNOWN}</Num>
        <Verdict>{verdictWord(null)}</Verdict>
        <Num>{UNKNOWN}</Num>
        <Num>{UNKNOWN}</Num>
        <Num>{UNKNOWN}</Num>
      </tr>
    );
  }
  return (
    <>
      {trials.map((row) => (
        <ResultRow key={`${row.case}-${row.trial}`} row={row} />
      ))}
    </>
  );
}

function ResultRow({ row }: { row: EvalCaseResultView }) {
  const metrics = readMetrics(row.metrics);
  const failures = failedAssertions(row.assertions);
  return (
    <>
      <tr className="border-t border-border">
        <Cell title={row.threadId ?? undefined}>{row.case}</Cell>
        <Num>{formatCount(row.trial)}</Num>
        <Verdict>{verdictWord(row.status)}</Verdict>
        <Num>{formatTokens(metrics.tokens)}</Num>
        <Num>{formatUsd(metrics.costUsd)}</Num>
        <Num>{formatDuration(metrics.wallMs)}</Num>
      </tr>
      {failures.map((failure) => (
        <tr key={`${row.case}-${row.trial}-${failure.key}`}>
          <td className="h-6 px-2 py-0 text-[11px] text-muted-foreground" colSpan={6}>
            <span className="pl-4">
              {failure.key}
              {failure.detail === "" ? "" : ` ${failure.detail}`}
            </span>
          </td>
        </tr>
      ))}
    </>
  );
}

function ResultsTable({ view }: { view: EvalRunView }) {
  const byCase = new Map<string, EvalCaseResultView[]>();
  for (const row of view.results) {
    const list = byCase.get(row.case) ?? [];
    list.push(row);
    byCase.set(row.case, list);
  }
  const names = runCaseOrder(view.run?.cases ?? [], view.results);
  if (names.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        this run recorded no cases
      </p>
    );
  }
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <TextHead>case</TextHead>
          <NumHead>trial</NumHead>
          <TextHead>verdict</TextHead>
          <NumHead>tokens</NumHead>
          <NumHead>cost usd</NumHead>
          <NumHead>wall</NumHead>
        </tr>
      </thead>
      <tbody>
        {names.map((name) => (
          <CaseBlock key={name} name={name} trials={byCase.get(name) ?? []} />
        ))}
      </tbody>
    </table>
  );
}

/** `eval/runs/<id>`. An unknown id renders one line, never a thrown rpc. */
export function EvalRun({ runId }: { runId: string }) {
  const navigate = useBbNavigate();
  const goTo = useCallback(
    (subPath: string) => navigate.toPluginPanel(PANEL_PATH, { subPath }),
    [navigate],
  );
  const query = useEvalQuery<EvalRunView>(
    "observatory_eval_run",
    { runId },
    fixtureRun,
  );

  return (
    <section className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading>{runId}</Heading>
        <button
          type="button"
          className="text-[11px] underline underline-offset-2"
          onClick={() => goTo("eval")}
        >
          all runs
        </button>
      </div>
      <EvalFrame query={query}>
        {(view) => {
          if (view.run === null) {
            return (
              <p className="text-[13px] text-muted-foreground">
                no run with id {runId}
              </p>
            );
          }
          const wall = elapsedMs(view.run.startedAt, view.run.finishedAt);
          return (
            <div className="flex flex-col gap-3">
              <HeroRow>
                <Hero label="gate" value={verdictWord(view.run.gate)} />
                <Hero
                  label="cases"
                  value={formatCount(view.run.cases.length)}
                />
                <Hero
                  label="cost usd"
                  value={formatUsd(totalCostUsd(view.results))}
                />
                <Hero label="wall" value={formatDuration(wall)} />
              </HeroRow>
              <MetaLine
                entries={[
                  ["status", view.run.status ?? UNKNOWN],
                  ["stack sha", view.run.stackSha ?? UNKNOWN],
                  ["tag", view.run.tag ?? UNKNOWN],
                  ["started utc", formatTime(view.run.startedAt)],
                  ["finished utc", formatTime(view.run.finishedAt)],
                ]}
              />
              <ResultsTable view={view} />
              <Heading>Baseline</Heading>
              <p className="text-[11px] text-muted-foreground">{THRESHOLDS}</p>
              <p className="text-[11px] text-muted-foreground">
                per-case deltas are not on the eval rpc contract; the run gate
                above carries the comparison
              </p>
              <p className="text-[11px] text-muted-foreground">
                {PROMOTE_NOTE}
              </p>
              <RowLink
                label="all cases"
                onClick={() => goTo("eval/cases")}
              />
            </div>
          );
        }}
      </EvalFrame>
    </section>
  );
}
