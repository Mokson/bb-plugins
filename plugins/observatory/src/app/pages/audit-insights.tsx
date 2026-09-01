// Insights: the same range folded three ways - what the money went to, which
// seat spent it, which model billed it.
//
// An actionable row is one concentrated enough that a rule would pay for
// itself, and the row says so in words rather than in colour. The word links
// to the watch settings route, which is where a rule is actually written, so
// the row hands the reader the next step rather than only naming it.
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import {
  Num,
  NumHead,
  QueryFrame,
  RangeSelect,
  TextHead,
} from "@/components/spend-common";
import { formatCount, formatShare, formatUsd } from "@/lib/format";
import { useModuleQuery } from "@/lib/module-rpc";
import { fixtureAuditInsights } from "@/fixtures/context";
import { PANEL_PATH } from "./routes.js";
import type { SpendRange } from "../../spend/contract.js";
import type { AuditInsightFacet } from "../../audit/contract.js";

const FACET_TITLES: Record<AuditInsightFacet["facet"], string> = {
  "failures-by-signature": "Cost drivers",
  "cost-by-seat": "Seats",
  "cost-by-model": "Models",
};

function FacetTable({ facet }: { facet: AuditInsightFacet }) {
  const navigate = useBbNavigate();
  const money = facet.unit === "usd";
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-[13px] font-semibold">{FACET_TITLES[facet.facet]}</h3>
      {facet.rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          nothing in this range
        </p>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-[11px] text-muted-foreground">
              <TextHead>label</TextHead>
              <NumHead>{money ? "usd" : "count"}</NumHead>
              <NumHead>share</NumHead>
              <TextHead>action</TextHead>
            </tr>
          </thead>
          <tbody>
            {facet.rows.map((row) => (
              <tr key={row.label} className="border-t border-border">
                <td className="h-6 max-w-[280px] truncate px-2 py-0">
                  {row.label}
                </td>
                <Num>{money ? formatUsd(row.value) : formatCount(row.value)}</Num>
                <Num>{formatShare(row.share)}</Num>
                <td className="h-6 px-2 py-0 text-muted-foreground">
                  {row.actionable ? (
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      onClick={() =>
                        navigate.toPluginPanel(PANEL_PATH, {
                          subPath: "settings",
                        })
                      }
                    >
                      rule
                    </button>
                  ) : (
                    ""
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function AuditInsights() {
  const [range, setRange] = useState<SpendRange>("7d");
  const query = useModuleQuery<{ facets: AuditInsightFacet[] }>(
    "observatory_audit_insights",
    { range },
    fixtureAuditInsights,
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <RangeSelect value={range} onChange={setRange} />
      </div>
      <QueryFrame query={query}>
        {(data) => (
          <>
            {data.facets.map((facet) => (
              <FacetTable key={facet.facet} facet={facet} />
            ))}
            <p className="text-[11px] text-muted-foreground">
              a row marked `rule` is concentrated enough to be worth a watch
              rule; the link opens the watch settings that hold them
            </p>
          </>
        )}
      </QueryFrame>
    </div>
  );
}
