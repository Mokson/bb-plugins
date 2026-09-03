import { useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Device = {
  id: string;
  name: string;
  enabled: boolean;
  notifyIdle: boolean;
  notifyFailed: boolean;
  notifyPending: boolean;
  showPreview: boolean;
  createdAt: number;
  updatedAt: number;
};

type Filters = {
  suppressSubagents: boolean;
  minTurnSeconds: number;
  mutedProjectIds: string[];
};

type Project = { id: string; name: string };

type PushState = {
  vapidPublicKey: string;
  workerUrl: string;
  workerScope: string;
  devices: Device[];
  filters: Filters;
};

const DEVICE_ID_KEY = "bb-push-notify:device-id";
const DEVICE_NAME_KEY = "bb-push-notify:device-name";
const MAX_MIN_TURN_SECONDS = 3600;
const MAX_MUTED_PROJECTS = 500;
let fallbackDeviceId: string | null = null;
let fallbackDeviceName = "This browser";

type PreparedWorker = {
  registration: ServiceWorkerRegistration;
  subscription: PushSubscription | null;
};

function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

function getDeviceId(): string {
  let existing: string | null = null;
  try {
    existing = window.localStorage.getItem(DEVICE_ID_KEY);
  } catch {
    // Some privacy modes expose localStorage but reject access to it.
  }
  if (existing) return existing;
  fallbackDeviceId ??=
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    window.localStorage.setItem(DEVICE_ID_KEY, fallbackDeviceId);
  } catch {
    // Keep the module-scoped id stable for this page session.
  }
  return fallbackDeviceId;
}

function defaultDeviceName(): string {
  try {
    const stored = window.localStorage.getItem(DEVICE_NAME_KEY);
    if (stored) fallbackDeviceName = stored;
  } catch {
    // Fall back to memory when browser storage is unavailable.
  }
  return fallbackDeviceName;
}

function rememberDeviceName(name: string): void {
  fallbackDeviceName = name;
  try {
    window.localStorage.setItem(DEVICE_NAME_KEY, name);
  } catch {
    // The server still persists the name for the registered device.
  }
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const bytes = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(bytes.length));
  for (let index = 0; index < bytes.length; index += 1) {
    output[index] = bytes.charCodeAt(index);
  }
  return output;
}

function sameApplicationServerKey(
  subscription: PushSubscription,
  expected: Uint8Array<ArrayBuffer>,
): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return (
    bytes.length === expected.length &&
    bytes.every((value, index) => value === expected[index])
  );
}

function waitForActiveWorker(
  registration: ServiceWorkerRegistration,
): Promise<ServiceWorkerRegistration> {
  if (registration.active) return Promise.resolve(registration);
  return new Promise((resolve, reject) => {
    let worker: ServiceWorker | null = null;
    let timeoutId: number | undefined;

    const cleanup = () => {
      registration.removeEventListener("updatefound", attachWorker);
      worker?.removeEventListener("statechange", onStateChange);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
    const finishIfActive = () => {
      if (!registration.active) return false;
      cleanup();
      resolve(registration);
      return true;
    };
    const onStateChange = () => {
      if (finishIfActive()) return;
      if (!worker) return;
      if (worker.state === "activated") {
        cleanup();
        resolve(registration);
      } else if (worker.state === "redundant") {
        cleanup();
        reject(new Error("Service worker installation failed"));
      }
    };
    function attachWorker() {
      if (finishIfActive()) return;
      const nextWorker = registration.installing ?? registration.waiting;
      if (!nextWorker || nextWorker === worker) return;
      worker?.removeEventListener("statechange", onStateChange);
      worker = nextWorker;
      worker.addEventListener("statechange", onStateChange);
      onStateChange();
    }

    registration.addEventListener("updatefound", attachWorker);
    timeoutId = window.setTimeout(() => {
      if (finishIfActive()) return;
      cleanup();
      reject(new Error("Service worker activation timed out"));
    }, 15_000);
    attachWorker();
  });
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error ? `${fallback}: ${error.message}` : fallback;
}

function SettingsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [pushState, setPushState] = useState<PushState | null>(null);
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    pushSupported() ? Notification.permission : "denied",
  );
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [renamingDevice, setRenamingDevice] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparedWorker, setPreparedWorker] = useState<PreparedWorker | null>(
    null,
  );
  const [projects, setProjects] = useState<Project[]>([]);
  const [minTurnInput, setMinTurnInput] = useState("");
  const minTurnFocused = useRef(false);
  const supported = useMemo(pushSupported, []);
  const [deviceId] = useState(getDeviceId);
  const currentDevice = pushState?.devices.find(
    (device) => device.id === deviceId,
  );

  async function refresh(): Promise<PushState> {
    const next = await rpc.call("getPushState", null);
    setPushState(next);
    const current = next.devices.find((device) => device.id === deviceId);
    if (current) setDeviceName(current.name);
    if (!minTurnFocused.current) {
      setMinTurnInput(String(next.filters.minTurnSeconds));
    }
    return next;
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await refresh();
        try {
          const projectList = await rpc.call("listProjects", null);
          if (!cancelled) setProjects(projectList);
        } catch {
          // Project names are optional; muted ids still render without them.
        }
        if (!supported) return;
        const registration = await navigator.serviceWorker.register(
          next.workerUrl,
          { scope: next.workerScope },
        );
        await waitForActiveWorker(registration);
        const serverKey = applicationServerKey(next.vapidPublicKey);
        let subscription = await registration.pushManager.getSubscription();
        if (
          subscription &&
          !sameApplicationServerKey(subscription, serverKey)
        ) {
          await subscription.unsubscribe();
          subscription = null;
        }
        if (!cancelled) setPreparedWorker({ registration, subscription });
      } catch (error) {
        if (!cancelled) {
          setMessage(
            messageFor(error, "Could not prepare browser notifications"),
          );
        }
      }
    })();
    const updatePermission = () => {
      if (supported) setPermission(Notification.permission);
    };
    window.addEventListener("focus", updatePermission);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", updatePermission);
    };
  }, []);

  async function registerThisBrowser() {
    if (!supported || !pushState || !preparedWorker) return;
    setMessage(null);
    if (Notification.permission === "default") {
      setBusy(true);
      try {
        const nextPermission = await Notification.requestPermission();
        setPermission(nextPermission);
        setMessage(
          nextPermission === "granted"
            ? "Permission granted. Select Enable and test to finish setup."
            : "Notifications are blocked. Allow them in this site's browser settings, then try again.",
        );
      } catch (error) {
        setMessage(
          messageFor(error, "Could not request notification permission"),
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    if (Notification.permission !== "granted") {
      setPermission(Notification.permission);
      setMessage(
        "Notifications are blocked. Allow them in this site's browser settings, then try again.",
      );
      return;
    }

    // Invoke subscribe synchronously from the click. WebKit and other browsers
    // may require the transient user activation to still be present here.
    const subscriptionPromise = preparedWorker.subscription
      ? Promise.resolve(preparedWorker.subscription)
      : preparedWorker.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(
            pushState.vapidPublicKey,
          ),
        });
    setBusy(true);
    try {
      const subscription = await subscriptionPromise;
      setPreparedWorker({
        registration: preparedWorker.registration,
        subscription,
      });
      const serialized = subscription.toJSON();
      if (
        !serialized.endpoint ||
        !serialized.keys?.p256dh ||
        !serialized.keys.auth
      ) {
        throw new Error("Browser returned an incomplete push subscription");
      }

      const name = deviceName.trim() || "This browser";
      rememberDeviceName(name);
      await rpc.call("registerDevice", {
        id: deviceId,
        name,
        subscription: {
          endpoint: serialized.endpoint,
          keys: {
            p256dh: serialized.keys.p256dh,
            auth: serialized.keys.auth,
          },
        },
      });
      await rpc.call("sendTestNotification", { deviceId });
      await refresh();
      setMessage("This browser is registered. A test notification was sent.");
    } catch (error) {
      setMessage(messageFor(error, "Could not register this browser"));
    } finally {
      setBusy(false);
    }
  }

  async function updateDevice(
    id: string,
    changes: Partial<
      Pick<
        Device,
        | "name"
        | "enabled"
        | "notifyIdle"
        | "notifyFailed"
        | "notifyPending"
        | "showPreview"
      >
    >,
  ) {
    setBusy(true);
    try {
      await rpc.call("updateDevice", { id, ...changes });
      await refresh();
      setMessage("Notification preferences saved.");
    } catch (error) {
      setMessage(messageFor(error, "Could not update the device"));
    } finally {
      setBusy(false);
    }
  }

  async function updateFilters(changes: Partial<Filters>) {
    setBusy(true);
    try {
      await rpc.call("updateFilters", changes);
      await refresh();
      setMessage("Notification filters saved.");
    } catch (error) {
      setMessage(messageFor(error, "Could not update the filters"));
    } finally {
      setBusy(false);
    }
  }

  function saveMinTurnSeconds() {
    const trimmed = minTurnInput.trim();
    const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_MIN_TURN_SECONDS) {
      setMessage(
        `Minimum turn length must be between 0 and ${MAX_MIN_TURN_SECONDS} seconds.`,
      );
      if (pushState) setMinTurnInput(String(pushState.filters.minTurnSeconds));
      return;
    }
    if (parsed === pushState?.filters.minTurnSeconds) return;
    void updateFilters({ minTurnSeconds: parsed });
  }

  function toggleMutedProject(projectId: string, muted: boolean) {
    const current = pushState?.filters.mutedProjectIds ?? [];
    if (
      muted &&
      !current.includes(projectId) &&
      current.length >= MAX_MUTED_PROJECTS
    ) {
      setMessage(
        `You can mute up to ${MAX_MUTED_PROJECTS} projects. Unmute one to mute another.`,
      );
      return;
    }
    const next = muted
      ? [...new Set([...current, projectId])]
      : current.filter((id) => id !== projectId);
    void updateFilters({ mutedProjectIds: next });
  }

  async function saveDeviceName() {
    if (!currentDevice) return;
    const name = deviceName.trim();
    if (!name) return;
    if (name === currentDevice.name) {
      setRenamingDevice(false);
      return;
    }
    setBusy(true);
    try {
      rememberDeviceName(name);
      await rpc.call("updateDevice", { id: deviceId, name });
      await refresh();
      setRenamingDevice(false);
      setMessage("Device name saved.");
    } catch (error) {
      setMessage(messageFor(error, "Could not save the device name"));
    } finally {
      setBusy(false);
    }
  }

  function cancelDeviceRename() {
    if (currentDevice) setDeviceName(currentDevice.name);
    setRenamingDevice(false);
  }

  async function removeDevice(device: Device) {
    setBusy(true);
    try {
      // Delete server-side first so the device is always removable, even if
      // the local service worker cleanup below fails.
      await rpc.call("removeDevice", { id: device.id });
      let subscriptionCleanupFailed = false;
      if (
        device.id === deviceId &&
        pushState &&
        "serviceWorker" in navigator
      ) {
        try {
          const registration = await navigator.serviceWorker.getRegistration(
            pushState.workerScope,
          );
          const subscription =
            await registration?.pushManager.getSubscription();
          await subscription?.unsubscribe();
          await registration?.unregister();
        } catch {
          subscriptionCleanupFailed = true;
        }
      }
      await refresh();
      setMessage(
        subscriptionCleanupFailed
          ? `${device.name} was removed, but the browser push subscription could not be released.`
          : `${device.name} was removed.`,
      );
    } catch (error) {
      setMessage(messageFor(error, "Could not remove the device"));
    } finally {
      setBusy(false);
    }
  }

  async function sendTest(device: Device) {
    setBusy(true);
    try {
      await rpc.call("sendTestNotification", { deviceId: device.id });
      setMessage(`Test sent to ${device.name}.`);
    } catch (error) {
      setMessage(messageFor(error, "Could not send the test notification"));
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const status = !supported
    ? "Push notifications are unavailable in this browser"
    : permission === "denied"
      ? "Notifications are blocked by the browser"
      : currentDevice?.enabled
        ? "Push notifications are enabled on this browser"
        : currentDevice
          ? "This browser is registered but disabled"
          : "This browser is not registered";
  const devices = [...(pushState?.devices ?? [])].sort((left, right) => {
    if (left.id === deviceId) return -1;
    if (right.id === deviceId) return 1;
    return 0;
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Push notifications</CardTitle>
          <CardDescription>
            Receive notifications when a bb agent finishes or fails, even after
            bb is closed. Delivery goes directly from your bb server to each
            enabled browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <p className="text-sm font-medium text-foreground">{status}</p>
            <p className="text-sm text-muted-foreground">
              Permission: {supported ? permission : "unavailable"}
            </p>
          </div>

          {currentDevice ? (
            renamingDevice ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  aria-label="Device name"
                  value={deviceName}
                  maxLength={80}
                  autoFocus
                  onChange={(event) =>
                    setDeviceName(event.currentTarget.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveDeviceName();
                    if (event.key === "Escape") cancelDeviceRename();
                  }}
                />
                <div className="flex gap-2">
                  <Button
                    onClick={() => void saveDeviceName()}
                    disabled={busy || !deviceName.trim()}
                    className="shrink-0"
                  >
                    Save
                  </Button>
                  <Button
                    variant="outline"
                    onClick={cancelDeviceRename}
                    disabled={busy}
                    className="shrink-0"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">
                      {currentDevice.name}
                    </p>
                    <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      This browser
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {currentDevice.enabled
                      ? "Receiving notifications"
                      : "Notifications are disabled"}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  aria-label="Rename"
                  disabled={busy}
                  onClick={() => setRenamingDevice(true)}
                >
                  <Icon name="Edit" className="!size-3.5" aria-hidden="true" />
                </Button>
              </div>
            )
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                aria-label="Device name"
                value={deviceName}
                maxLength={80}
                onChange={(event) => setDeviceName(event.currentTarget.value)}
                placeholder="Name this browser"
              />
              <Button
                onClick={() => void registerThisBrowser()}
                disabled={!supported || !pushState || !preparedWorker || busy}
                className="shrink-0"
              >
                {permission === "default"
                  ? "Allow notifications"
                  : "Enable and test"}
              </Button>
            </div>
          )}

          {currentDevice ? (
            <div className="space-y-3 border-t border-border pt-4">
              <PreferenceToggle
                checked={currentDevice.notifyIdle}
                label="bb agent finished"
                description="Notify when a visible bb chat returns to idle."
                disabled={busy}
                onChange={(notifyIdle) =>
                  void updateDevice(deviceId, { notifyIdle })
                }
              />
              <PreferenceToggle
                checked={currentDevice.notifyFailed}
                label="bb agent failed"
                description="Notify when a visible bb chat enters an error state."
                disabled={busy}
                onChange={(notifyFailed) =>
                  void updateDevice(deviceId, { notifyFailed })
                }
              />
              <PreferenceToggle
                checked={currentDevice.notifyPending}
                label="bb agent needs you"
                description="Notify when a chat stops with a question or approval waiting."
                disabled={busy}
                onChange={(notifyPending) =>
                  void updateDevice(deviceId, { notifyPending })
                }
              />
              <PreferenceToggle
                checked={currentDevice.showPreview}
                label="Show details"
                description="Include a short response or error preview on this device."
                disabled={busy}
                onChange={(showPreview) =>
                  void updateDevice(deviceId, { showPreview })
                }
              />
            </div>
          ) : null}

          {message ? (
            <p className="text-sm text-muted-foreground" role="status">
              {message}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {pushState ? (
        <Card>
          <CardHeader>
            <CardTitle>Filters</CardTitle>
            <CardDescription>
              These filters apply to every device on this bb server.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <PreferenceToggle
              checked={pushState.filters.suppressSubagents}
              label="Ignore subagent threads"
              description="Skip finished and waiting notifications for threads started by another thread. Failures always notify."
              disabled={busy}
              onChange={(suppressSubagents) =>
                void updateFilters({ suppressSubagents })
              }
            />
            <div className="space-y-1">
              <label
                className="block text-sm font-medium text-foreground"
                htmlFor="push-notify-min-turn"
              >
                Minimum turn length
              </label>
              <p className="text-sm text-muted-foreground">
                Skip finished notifications for turns shorter than this many
                seconds. Use 0 to notify for every turn.
              </p>
              <Input
                id="push-notify-min-turn"
                aria-label="Minimum turn length in seconds"
                inputMode="numeric"
                className="max-w-32"
                value={minTurnInput}
                disabled={busy}
                onChange={(event) => setMinTurnInput(event.currentTarget.value)}
                onFocus={() => {
                  minTurnFocused.current = true;
                }}
                onBlur={() => {
                  minTurnFocused.current = false;
                  saveMinTurnSeconds();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveMinTurnSeconds();
                }}
              />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">
                Muted projects
              </p>
              <p className="text-sm text-muted-foreground">
                Muted projects send no notifications at all, failures included.
              </p>
              {projects.length ? (
                <div className="space-y-2 pt-1">
                  {projects.map((project) => (
                    <label
                      key={project.id}
                      className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                    >
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={pushState.filters.mutedProjectIds.includes(
                          project.id,
                        )}
                        disabled={busy}
                        onChange={(event) =>
                          toggleMutedProject(
                            project.id,
                            event.currentTarget.checked,
                          )
                        }
                      />
                      {project.name}
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No projects available to mute.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {devices.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Notification devices</CardTitle>
            <CardDescription>
              Only enabled devices receive notifications. Expired browser
              subscriptions are removed automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            {devices.map((device) => (
              <div
                key={device.id}
                className={`flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0 ${
                  device.id === deviceId ? "bg-muted/20" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">
                      {device.name}
                    </p>
                    {device.id === deviceId ? (
                      <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        This browser
                      </span>
                    ) : null}
                  </div>
                  <label className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={device.enabled}
                      disabled={busy}
                      onChange={(event) =>
                        void updateDevice(device.id, {
                          enabled: event.currentTarget.checked,
                        })
                      }
                    />
                    Receive notifications
                  </label>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Test ${device.name}`}
                    disabled={busy || !device.enabled}
                    onClick={() => void sendTest(device)}
                  >
                    <Icon
                      name="Beaker"
                      className="!size-3.5"
                      aria-hidden="true"
                    />
                    Test
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8 text-destructive hover:text-destructive"
                    aria-label={`Remove ${device.name}`}
                    disabled={busy}
                    onClick={() => void removeDevice(device)}
                  >
                    <Icon
                      name="Trash2"
                      className="!size-3.5"
                      aria-hidden="true"
                    />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function PreferenceToggle({
  checked,
  label,
  description,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  description: string;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="mt-1 size-4 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-sm text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "push-notify-notifications",
    component: SettingsSection,
  });
});
