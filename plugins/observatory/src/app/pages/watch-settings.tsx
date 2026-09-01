// The watch module's editable settings: the mode, and the rule thresholds.
//
// This is the plugin's only write path from the panel. Two rules shape it.
// First, only changed thresholds are sent (`lib/thresholds.ts`), because
// writing a value stores a KV override and rewriting every row would detach
// the whole table from the plugin settings. Second, the server's answer wins:
// the table redraws from the response rather than from what was typed, so a
// value the server clamped or refused is visible immediately.
import { useCallback, useEffect, useState } from "react";
import { Heading, QueryFrame } from "@/components/watch-common";
import {
  changedThresholds,
  discardDraft,
  hasChanges,
  thresholdRows,
  withDraft,
  type ThresholdRow,
} from "@/lib/thresholds";
import {
  isFixtureMode,
  useWatchQuery,
  useWatchSettingsWrite,
} from "@/lib/watch-rpc";
import { fixtureWatchSettings } from "@/fixtures/watch";
import type { WatchMode, WatchSettings } from "../../watch/contract.js";

const MODES: readonly WatchMode[] = ["off", "observe", "steer"];

/** What each mode does, in one line, so the radio is self-explanatory. */
const MODE_HELP: Record<WatchMode, string> = {
  off: "record nothing",
  observe: "record signals, send nothing",
  steer: "record and send steers up the ladder",
};

function SettingsForm({ initial }: { initial: WatchSettings }) {
  const write = useWatchSettingsWrite();
  const fixture = isFixtureMode();
  const [settings, setSettings] = useState(initial);
  const [rows, setRows] = useState<ThresholdRow[]>(() =>
    thresholdRows(initial),
  );
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A fresh server answer replaces both the mode and any unsaved drafts: the
  // page has no claim on a number the server has since changed.
  useEffect(() => {
    setSettings(initial);
    setRows(thresholdRows(initial));
  }, [initial]);

  const apply = useCallback(
    async (input: Record<string, unknown>, local: WatchSettings) => {
      setFailure(null);
      // Fixture mode never touches the network, so the page can be driven and
      // screenshotted with no server behind it.
      if (fixture) {
        setSettings(local);
        setRows(thresholdRows(local));
        setNote(local.mode === "steer" ? "fixture: nothing is sent" : null);
        return;
      }
      setBusy(true);
      const result = await write(input);
      setBusy(false);
      if (result.kind === "failed") {
        setFailure(result.message);
        return;
      }
      setSettings(result.settings);
      setRows(thresholdRows(result.settings));
      setNote(result.settings.note ?? null);
    },
    [fixture, write],
  );

  const setMode = useCallback(
    (mode: WatchMode) => {
      void apply({ mode }, { ...settings, mode });
    },
    [apply, settings],
  );

  const save = useCallback(() => {
    const thresholds = changedThresholds(rows);
    void apply(
      { thresholds },
      { ...settings, thresholds: { ...settings.thresholds, ...thresholds } },
    );
  }, [apply, rows, settings]);

  const reset = useCallback(
    (key: string) => {
      setRows((current) => discardDraft(current, key));
      void apply({ reset: [key] }, settings);
    },
    [apply, settings],
  );

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-1">
        <legend className="text-[11px] text-muted-foreground">watch mode</legend>
        {MODES.map((mode) => (
          <label key={mode} className="flex h-6 items-center gap-2">
            <input
              type="radio"
              name="watch-mode"
              value={mode}
              aria-label={mode}
              checked={settings.mode === mode}
              disabled={busy}
              onChange={() => setMode(mode)}
            />
            <span>{mode}</span>
            <span className="text-[11px] text-muted-foreground">
              {MODE_HELP[mode]}
            </span>
          </label>
        ))}
      </fieldset>
      {settings.mode === "steer" && note !== null ? (
        <p className="text-[11px] text-muted-foreground">{note}</p>
      ) : null}
      {failure === null ? null : (
        <p className="text-[13px] text-muted-foreground">{failure}</p>
      )}

      <table className="w-full text-[13px]">
        <caption className="pb-1 text-left text-[11px] text-muted-foreground">
          thresholds
        </caption>
        <thead>
          <tr className="text-[11px] text-muted-foreground">
            <th className="px-2 py-1 text-left font-normal">key</th>
            <th className="px-2 py-1 text-right font-normal tabular-nums">
              value
            </th>
            <th className="px-2 py-1 text-left font-normal">source</th>
            <th className="px-2 py-1 text-left font-normal">reset</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-border">
              <td className="h-6 px-2 py-0">{row.key}</td>
              <td className="h-6 px-2 py-0 text-right">
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label={row.key}
                  value={row.draft}
                  disabled={busy}
                  onChange={(event) =>
                    setRows((current) =>
                      withDraft(current, row.key, event.target.value),
                    )
                  }
                  className="h-5 w-24 rounded-[4px] border-b border-border bg-transparent px-1 text-right text-[13px] tabular-nums outline-none"
                />
              </td>
              <td className="h-6 px-2 py-0">{row.source}</td>
              <td className="h-6 px-2 py-0">
                {row.source === "kv" ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Reset ${row.key} to setting`}
                    className="text-[11px] underline underline-offset-2"
                    onClick={() => reset(row.key)}
                  >
                    to setting
                  </button>
                ) : (
                  <span className="text-[11px] text-muted-foreground">--</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy || !hasChanges(rows)}
          className="text-[13px] underline underline-offset-2 disabled:no-underline disabled:opacity-50"
          onClick={save}
        >
          save thresholds
        </button>
        <span className="text-[11px] text-muted-foreground">
          {Object.keys(changedThresholds(rows)).length} changed
        </span>
      </div>
    </div>
  );
}

/** The watch half of the panel's settings route. */
export function WatchSettingsPage() {
  const query = useWatchQuery<WatchSettings>(
    "observatory_watch_settings_get",
    {},
    fixtureWatchSettings,
  );
  return (
    <section className="flex flex-col gap-3 py-4 text-[13px]">
      <Heading>Watch</Heading>
      <QueryFrame query={query}>
        {(settings) => <SettingsForm initial={settings} />}
      </QueryFrame>
    </section>
  );
}
