// The settings display: read-only, with one named edit location.
//
// There is no write path and none is planned: `PluginSettingsState` is
// read-only and no API routes a panel to bb's own settings form, so the edit
// location is text, stated once.
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useStatus } from "./status.js";

export function ObservatorySettings() {
  const state = useStatus();
  if (state.kind === "loading") return <Skeleton className="mt-4 h-24 w-full" />;
  if (state.kind === "error") {
    return (
      <p className="py-4 text-[13px] text-muted-foreground">{state.message}</p>
    );
  }
  const { status } = state;
  return (
    <section className="flex flex-col gap-3 py-4 text-[13px]">
      <h2 className="text-[16px] font-semibold">Settings</h2>
      <p className="text-[11px] text-muted-foreground">
        Edit under Extensions, Plugins, Observatory, or with
        {" `bb plugin config observatory set <key> <value>`"}. Module toggles
        apply on {" `bb plugin reload observatory`"}.
      </p>
      <table className="w-full">
        <tbody>
          {status.modules.map((module) => (
            <tr key={module.id} className="border-t border-border">
              <td className="h-6 py-0">{`modules_${module.id}_enabled`}</td>
              <td className="h-6 py-0 text-right">
                {module.enabled ? "on" : "off"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Separator />
      <table className="w-full">
        <tbody>
          {status.settings.map((setting) => (
            <tr key={setting.key} className="border-t border-border">
              <td className="h-6 py-0">{setting.key}</td>
              <td className="h-6 py-0 text-right tabular-nums">
                {setting.value === "" ? "--" : setting.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
