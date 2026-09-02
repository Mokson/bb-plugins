// The eval cases route: every case the loader saw, and one case in detail.
//
// The list is the page. A case that failed to parse keeps its row rather than
// vanishing - `observatory_eval_cases` is total by design, returning `valid:
// false` with the offending key path - and its error renders indented beneath
// the row, the same shape the run page uses for a failed assertion.
//
// Two fields the design asked for are NOT on the wire on this branch: a case's
// `trials` count and its parsed body (fixture, invocation, limits, assertion
// keys). `evalCaseSummarySchema` carries name, tags, path, validity and the
// last result, and nothing else. Both render `--` with one line naming the
// case file as the source, because inventing a number the rpc never sent is
// the one failure this module is built against.
import { useCallback } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Heading, Hero, NumHead, TextHead } from "@/components/spend-common";
import {
  Cell,
  EvalFrame,
  HeroRow,
  MetaLine,
  RowLink,
  Verdict,
} from "@/components/eval-common";
import { UNKNOWN, formatCount, formatTime } from "@/lib/format";
import { useEvalQuery } from "@/lib/eval-rpc";
import { verdictWord } from "@/lib/eval-view";
import { fixtureCases, fixtureRuns } from "@/fixtures/eval";
import { PANEL_PATH } from "./routes.js";
import type {
  EvalCaseSummary,
  EvalCasesView,
  EvalRunSummary,
  EvalRunsView,
} from "../../eval/contract.js";

/** How many runs the history strip shows. Newest first, from the server. */
const RUN_LIMIT = 20;

const BODY_NOTE =
  "trials and the case body (fixture, invocation, limits, assertion keys) are not on the eval rpc; the case file is the source";

function useNav(): (subPath: string) => void {
  const navigate = useBbNavigate();
  return useCallback(
    (subPath: string) => navigate.toPluginPanel(PANEL_PATH, { subPath }),
    [navigate],
  );
}

function useCasesQuery() {
  return useEvalQuery<EvalCasesView>("observatory_eval_cases", {}, fixtureCases);
}

function useRunsQuery() {
  return useEvalQuery<EvalRunsView>(
    "observatory_eval_runs",
    { limit: RUN_LIMIT },
    fixtureRuns,
  );
}

function CaseRow({
  entry,
  onOpen,
}: {
  entry: EvalCaseSummary;
  onOpen: () => void;
}) {
  return (
    <>
      <tr className="border-t border-border">
        <Cell>
          <RowLink label={entry.name} onClick={onOpen} />
        </Cell>
        <Cell title={entry.tags.join(", ")}>
          {entry.tags.length === 0 ? UNKNOWN : entry.tags.join(" ")}
        </Cell>
        <td className="h-6 whitespace-nowrap px-2 py-0 text-right tabular-nums">
          {UNKNOWN}
        </td>
        <Cell>{entry.lastResult?.runId ?? UNKNOWN}</Cell>
        <Verdict>{verdictWord(entry.lastResult?.status)}</Verdict>
      </tr>
      {entry.valid ? null : (
        <tr>
          <td className="h-6 px-2 py-0 text-[11px] text-muted-foreground" colSpan={5}>
            <span className="pl-4">{entry.error ?? "did not parse"}</span>
          </td>
        </tr>
      )}
    </>
  );
}

function CasesTable({
  cases,
  onOpen,
}: {
  cases: readonly EvalCaseSummary[];
  onOpen: (name: string) => void;
}) {
  if (cases.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        no case files under the configured cases directory
      </p>
    );
  }
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <TextHead>case</TextHead>
          <TextHead>tags</TextHead>
          <NumHead>trials</NumHead>
          <TextHead>last run</TextHead>
          <TextHead>last verdict</TextHead>
        </tr>
      </thead>
      <tbody>
        {cases.map((entry) => (
          <CaseRow
            key={entry.path}
            entry={entry}
            onOpen={() => onOpen(entry.name)}
          />
        ))}
      </tbody>
    </table>
  );
}

function RunsTable({
  runs,
  onOpen,
}: {
  runs: readonly EvalRunSummary[];
  onOpen: (runId: string) => void;
}) {
  if (runs.length === 0) {
    return <p className="text-[13px] text-muted-foreground">no runs recorded</p>;
  }
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <TextHead>run</TextHead>
          <TextHead>started utc</TextHead>
          <TextHead>tag</TextHead>
          <NumHead>cases</NumHead>
          <TextHead>status</TextHead>
          <TextHead>gate</TextHead>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id} className="border-t border-border">
            <Cell>
              <RowLink label={run.id} onClick={() => onOpen(run.id)} />
            </Cell>
            <Cell>{formatTime(run.startedAt)}</Cell>
            <Cell>{run.tag ?? UNKNOWN}</Cell>
            <td className="h-6 whitespace-nowrap px-2 py-0 text-right tabular-nums">
              {formatCount(run.cases.length)}
            </td>
            <Cell>{run.status ?? UNKNOWN}</Cell>
            <Verdict>{verdictWord(run.gate)}</Verdict>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The run ids that selected this case, newest first. */
function historyFor(
  runs: readonly EvalRunSummary[],
  name: string,
): EvalRunSummary[] {
  return runs.filter((run) => run.cases.includes(name));
}

function CaseDetail({ name }: { name: string }) {
  const goTo = useNav();
  const cases = useCasesQuery();
  const runs = useRunsQuery();

  return (
    <section className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading>{name}</Heading>
        <button
          type="button"
          className="text-[11px] underline underline-offset-2"
          onClick={() => goTo("eval/cases")}
        >
          all cases
        </button>
      </div>
      <EvalFrame query={cases}>
        {(view) => {
          const entry = view.cases.find((candidate) => candidate.name === name);
          if (entry === undefined) {
            return (
              <p className="text-[13px] text-muted-foreground">
                no case named {name}
              </p>
            );
          }
          return (
            <div className="flex flex-col gap-3">
              <HeroRow>
                <Hero label="trials" value={UNKNOWN} />
                <Hero
                  label="last verdict"
                  value={verdictWord(entry.lastResult?.status)}
                />
                <Hero label="state" value={entry.valid ? "VALID" : "INVALID"} />
              </HeroRow>
              <MetaLine
                entries={[
                  ["path", entry.path],
                  ["tags", entry.tags.length === 0 ? UNKNOWN : entry.tags.join(" ")],
                  ["last run", entry.lastResult?.runId ?? UNKNOWN],
                  [
                    "last trial",
                    entry.lastResult === null
                      ? UNKNOWN
                      : formatCount(entry.lastResult.trial),
                  ],
                ]}
              />
              {entry.valid ? null : (
                <p className="text-[13px]">{entry.error ?? "did not parse"}</p>
              )}
              <p className="text-[11px] text-muted-foreground">{BODY_NOTE}</p>
              <Heading>Run history</Heading>
              <EvalFrame query={runs}>
                {(runsView) => (
                  <RunsTable
                    runs={historyFor(runsView.runs, name)}
                    onOpen={(runId) => goTo(`eval/runs/${runId}`)}
                  />
                )}
              </EvalFrame>
            </div>
          );
        }}
      </EvalFrame>
    </section>
  );
}

function CasesOverview() {
  const goTo = useNav();
  const cases = useCasesQuery();
  const runs = useRunsQuery();

  return (
    <section className="flex flex-col gap-3 py-4">
      <Heading>Eval</Heading>
      <EvalFrame query={cases}>
        {(view) => (
          <div className="flex flex-col gap-3">
            <HeroRow>
              <Hero label="cases" value={formatCount(view.cases.length)} />
              <Hero
                label="invalid"
                value={formatCount(
                  view.cases.filter((entry) => !entry.valid).length,
                )}
              />
              <Hero
                label="last fail"
                value={formatCount(
                  view.cases.filter(
                    (entry) => verdictWord(entry.lastResult?.status) === "FAIL",
                  ).length,
                )}
              />
            </HeroRow>
            <CasesTable
              cases={view.cases}
              onOpen={(name) => goTo(`eval/cases/${encodeURIComponent(name)}`)}
            />
            <p className="text-[11px] text-muted-foreground">{BODY_NOTE}</p>
          </div>
        )}
      </EvalFrame>
      <Heading>Runs</Heading>
      <EvalFrame query={runs}>
        {(view) => (
          <RunsTable
            runs={view.runs}
            onOpen={(runId) => goTo(`eval/runs/${runId}`)}
          />
        )}
      </EvalFrame>
    </section>
  );
}

/** `eval` and `eval/cases` render the list; `eval/cases/<name>` the detail. */
export function EvalCases({ caseName }: { caseName?: string | undefined }) {
  if (caseName === undefined || caseName === "") return <CasesOverview />;
  return <CaseDetail name={decodeURIComponent(caseName)} />;
}
