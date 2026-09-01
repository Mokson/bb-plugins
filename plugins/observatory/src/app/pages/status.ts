// The panel's one data hook. Every route reads the same status object, so a
// module's state cannot read one way on the inbox and another on settings.
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { observatoryContract, StatusView } from "../../contract.js";

export type StatusState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; status: StatusView };

export function useStatus(): StatusState {
  const rpc = useRpc<typeof observatoryContract>();
  const [state, setState] = useState<StatusState>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const status = await rpc.call("observatory_status", {});
      setState({ kind: "ready", status });
    } catch (error) {
      setState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Cannot reach the Observatory plugin.",
      });
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  return state;
}
