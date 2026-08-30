type RpcHandlers = Record<string, (input: any) => any>;

let rpcHandlers: RpcHandlers = {};

export function setTestRpcHandlers(next: RpcHandlers): void {
  rpcHandlers = next;
}

export function useRpc() {
  return {
    call(method: string, input: any) {
      const handler = rpcHandlers[method];
      if (!handler) throw new Error(`Missing test RPC handler: ${method}`);
      return Promise.resolve(handler(input));
    },
  };
}

export function definePluginApp(
  setup: (app: {
    slots: {
      settingsSection(registration: {
        id: string;
        component: () => unknown;
      }): void;
    };
  }) => void,
) {
  const settingsSections: Array<{ id: string; component: () => unknown }> = [];
  setup({
    slots: {
      settingsSection(registration) {
        settingsSections.push(registration);
      },
    },
  });
  return { settingsSections };
}
