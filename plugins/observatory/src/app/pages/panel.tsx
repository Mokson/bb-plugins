// The panel shell: a tab strip over one route each.
//
// Density rules (plan §UX): one font, sizes 11/13/16, weights 400 and 600,
// hairlines not boxes, numerics right-aligned with tabular-nums, unknown
// renders `--`. No colour carries hierarchy and there are no emojis, so the
// same page reads the same in either theme and in a screenshot.
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ObservatorySettings } from "./settings.js";
import { PANEL_PATH, PLACEHOLDERS, ROUTES } from "./routes.js";
import { CostOverview } from "./cost.js";
import { CostCache } from "./cost-cache.js";
import { ThreadCost } from "./thread-cost.js";
import { InboxPage } from "./inbox.js";
import { StallsPage } from "./stalls.js";
import { Trajectory } from "./trajectory.js";
import { WatchSettingsPage } from "./watch-settings.js";

export { PANEL_PATH, PLACEHOLDERS, ROUTES };

function Heading({ title }: { title: string }) {
  return <h2 className="text-[16px] font-semibold">{title}</h2>;
}

function Placeholder({ route }: { route: string }) {
  const title = ROUTES.find((entry) => entry.id === route)?.title ?? route;
  return (
    <section className="flex flex-col gap-2 py-4">
      <Heading title={title} />
      <p className="text-[13px] text-muted-foreground">
        {PLACEHOLDERS[route] ?? "Not built yet."}
      </p>
    </section>
  );
}

/**
 * The route body for one `subPath`.
 *
 * Segments, not a matcher: the panel owns a handful of addresses and a table
 * of string comparisons is easier to audit than a pattern language. The tab
 * strip highlights the first segment, so `cost/cache` keeps Cost selected.
 */
function Route({ segments }: { segments: readonly string[] }) {
  const [head, second, third] = segments;

  if (head === undefined || head === "") return <InboxPage />;
  if (head === "settings") {
    return (
      <>
        <WatchSettingsPage />
        <ObservatorySettings />
      </>
    );
  }
  if (head === "stalls") return <StallsPage />;
  if (head === "threads" && second !== undefined) {
    if (third === "trajectory") return <Trajectory threadId={second} />;
    return <ThreadCost threadId={second} />;
  }
  if (head === "cost") {
    if (second === "cache") return <CostCache threadId={third} />;
    return <CostOverview />;
  }
  return <Placeholder route={head} />;
}

export function ObservatoryPanel({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const segments = subPath.split("/").filter((segment) => segment !== "");
  const route = segments[0] ?? "";
  return (
    <div className="flex flex-col px-4 text-[13px]">
      <Tabs
        value={route}
        onValueChange={(next) =>
          navigate.toPluginPanel(PANEL_PATH, { subPath: next })
        }
      >
        <TabsList>
          {ROUTES.map((entry) => (
            <TabsTrigger key={entry.id || "inbox"} value={entry.id}>
              {entry.title}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Route segments={segments} />
    </div>
  );
}
