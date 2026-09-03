// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTestRpcHandlers } from "./test/plugin-sdk-app";

const subscription = {
  options: { applicationServerKey: null },
  toJSON: () => ({
    endpoint: "https://push.example/device",
    keys: { p256dh: "p256dh", auth: "auth" },
  }),
  unsubscribe: vi.fn(),
};

const subscribe = vi.fn(() => Promise.resolve(subscription));
const getSubscription = vi.fn(() => Promise.resolve(null));
const registration = {
  active: {},
  pushManager: { getSubscription, subscribe },
};
const registerWorker = vi.fn(() => Promise.resolve(registration));
let permission: NotificationPermission;
const requestPermission = vi.fn(async () => {
  permission = "granted";
  return permission;
});

async function loadSettingsSection() {
  const app = (await import("./app")).default as unknown as {
    settingsSections: Array<{ component: React.ComponentType }>;
  };
  return app.settingsSections[0]!.component;
}

describe("notification settings", () => {
  beforeEach(() => {
    permission = "default";
    vi.clearAllMocks();
    window.localStorage.clear();
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(window, "PushManager", {
      configurable: true,
      value: class PushManager {},
    });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: class Notification {
        static get permission() {
          return permission;
        }

        static requestPermission = requestPermission;
      },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: registerWorker },
    });
    setTestRpcHandlers({
      getPushState: () => ({
        vapidPublicKey:
          "BOr7x74zSaD4vKLqHY4oQkhh3m9sHHOu8tC9mCtcZp7yyroLvBaY5qxG6qrU8PCo1uAqkp6hN7y5jXQOX7vaKNg",
        workerUrl:
          "/api/v1/plugins/push-notify/http/service-worker.js",
        workerScope: "/api/v1/plugins/push-notify/http/",
        devices: [],
        filters: {
          suppressSubagents: true,
          minTurnSeconds: 30,
          mutedProjectIds: [],
        },
      }),
      listProjects: () => [],
      registerDevice: () => ({}),
      sendTestNotification: () => ({ sent: true }),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("still renders when localStorage access is rejected", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const SettingsSection = await loadSettingsSection();

    render(<SettingsSection />);

    expect(
      await screen.findByText("This browser is not registered"),
    ).toBeTruthy();
    expect(await screen.findByRole("button")).toBeTruthy();
  });

  it("prepares the worker and uses separate permission and subscribe clicks", async () => {
    const SettingsSection = await loadSettingsSection();
    render(<SettingsSection />);

    const permissionButton = await screen.findByRole("button", {
      name: "Allow notifications",
    });
    await waitFor(() =>
      expect((permissionButton as HTMLButtonElement).disabled).toBe(false),
    );
    expect(registerWorker).toHaveBeenCalledTimes(1);
    expect(getSubscription).toHaveBeenCalledTimes(1);

    fireEvent.click(permissionButton);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(subscribe).not.toHaveBeenCalled();
    const enableButton = await screen.findByRole("button", {
      name: "Enable and test",
    });

    fireEvent.click(enableButton);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(registerWorker).toHaveBeenCalledTimes(1);
    expect(getSubscription).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(
        "This browser is registered. A test notification was sent.",
      ),
    ).toBeTruthy();
  });

  it("shows a registered browser as read-only while keeping device actions", async () => {
    permission = "granted";
    window.localStorage.setItem(
      "bb-push-notify:device-id",
      "current-browser",
    );
    let currentName = "redmibook-browser";
    const updateDevice = vi.fn((input: { id: string; name?: string }) => {
      if (input.id === "current-browser" && input.name) {
        currentName = input.name;
      }
      return {};
    });
    setTestRpcHandlers({
      getPushState: () => ({
        vapidPublicKey:
          "BOr7x74zSaD4vKLqHY4oQkhh3m9sHHOu8tC9mCtcZp7yyroLvBaY5qxG6qrU8PCo1uAqkp6hN7y5jXQOX7vaKNg",
        workerUrl:
          "/api/v1/plugins/push-notify/http/service-worker.js",
        workerScope: "/api/v1/plugins/push-notify/http/",
        devices: [
          {
            id: "other-browser",
            name: "mobile",
            enabled: true,
            notifyIdle: true,
            notifyFailed: true,
            notifyPending: true,
            showPreview: false,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "current-browser",
            name: currentName,
            enabled: true,
            notifyIdle: true,
            notifyFailed: true,
            notifyPending: true,
            showPreview: false,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        filters: {
          suppressSubagents: true,
          minTurnSeconds: 30,
          mutedProjectIds: ["project-1"],
        },
      }),
      listProjects: () => [
        { id: "project-1", name: "Website" },
        { id: "project-2", name: "Docs" },
      ],
      updateDevice,
      sendTestNotification: () => ({ sent: true }),
      removeDevice: () => ({}),
    });
    const SettingsSection = await loadSettingsSection();
    render(<SettingsSection />);

    expect(
      await screen.findByText("Push notifications are enabled on this browser"),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Device name" })).toBeNull();
    expect(screen.getAllByText("This browser")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Test redmibook-browser" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test mobile" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove redmibook-browser" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove mobile" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send test" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const nameInput = screen.getByRole("textbox", { name: "Device name" });
    fireEvent.change(nameInput, { target: { value: "RedmiBook Chrome" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateDevice).toHaveBeenCalledWith({
        id: "current-browser",
        name: "RedmiBook Chrome",
      }),
    );
    expect(
      await screen.findAllByText("RedmiBook Chrome"),
    ).toHaveLength(2);
    expect(screen.queryByRole("textbox", { name: "Device name" })).toBeNull();
  });

  it("edits the global filters", async () => {
    permission = "granted";
    const updateFilters = vi.fn(() => ({
      suppressSubagents: false,
      minTurnSeconds: 60,
      mutedProjectIds: ["project-2"],
    }));
    setTestRpcHandlers({
      getPushState: () => ({
        vapidPublicKey:
          "BOr7x74zSaD4vKLqHY4oQkhh3m9sHHOu8tC9mCtcZp7yyroLvBaY5qxG6qrU8PCo1uAqkp6hN7y5jXQOX7vaKNg",
        workerUrl: "/api/v1/plugins/push-notify/http/service-worker.js",
        workerScope: "/api/v1/plugins/push-notify/http/",
        devices: [],
        filters: {
          suppressSubagents: true,
          minTurnSeconds: 30,
          mutedProjectIds: [],
        },
      }),
      listProjects: () => [{ id: "project-2", name: "Docs" }],
      updateFilters,
    });
    const SettingsSection = await loadSettingsSection();
    render(<SettingsSection />);

    const minTurn = await screen.findByRole("textbox", {
      name: "Minimum turn length in seconds",
    });
    expect((minTurn as HTMLInputElement).value).toBe("30");
    fireEvent.change(minTurn, { target: { value: "60" } });
    fireEvent.blur(minTurn);
    await waitFor(() =>
      expect(updateFilters).toHaveBeenCalledWith({ minTurnSeconds: 60 }),
    );

    fireEvent.click(screen.getByLabelText("Docs"));
    await waitFor(() =>
      expect(updateFilters).toHaveBeenCalledWith({
        mutedProjectIds: ["project-2"],
      }),
    );
  });

  it.each(["60abc", "5.5", "-1", ""])(
    "rejects invalid minimum turn %p",
    async (value) => {
      const updateFilters = vi.fn();
      setTestRpcHandlers({
        getPushState: () => ({
          vapidPublicKey:
            "BOr7x74zSaD4vKLqHY4oQkhh3m9sHHOu8tC9mCtcZp7yyroLvBaY5qxG6qrU8PCo1uAqkp6hN7y5jXQOX7vaKNg",
          workerUrl: "/api/v1/plugins/push-notify/http/service-worker.js",
          workerScope: "/api/v1/plugins/push-notify/http/",
          devices: [],
          filters: {
            suppressSubagents: true,
            minTurnSeconds: 30,
            mutedProjectIds: [],
          },
        }),
        listProjects: () => [],
        updateFilters,
      });
      const SettingsSection = await loadSettingsSection();
      render(<SettingsSection />);

      const minTurn = await screen.findByRole("textbox", {
        name: "Minimum turn length in seconds",
      });
      fireEvent.change(minTurn, { target: { value } });
      fireEvent.blur(minTurn);

      expect(updateFilters).not.toHaveBeenCalled();
      expect(
        await screen.findByText(
          "Minimum turn length must be between 0 and 3600 seconds.",
        ),
      ).toBeTruthy();
      expect((minTurn as HTMLInputElement).value).toBe("30");
    },
  );

  it("blocks muting a 501st project", async () => {
    const updateFilters = vi.fn();
    const mutedProjectIds = Array.from(
      { length: 500 },
      (_value, index) => `project-${index}`,
    );
    setTestRpcHandlers({
      getPushState: () => ({
        vapidPublicKey:
          "BOr7x74zSaD4vKLqHY4oQkhh3m9sHHOu8tC9mCtcZp7yyroLvBaY5qxG6qrU8PCo1uAqkp6hN7y5jXQOX7vaKNg",
        workerUrl: "/api/v1/plugins/push-notify/http/service-worker.js",
        workerScope: "/api/v1/plugins/push-notify/http/",
        devices: [],
        filters: {
          suppressSubagents: true,
          minTurnSeconds: 30,
          mutedProjectIds,
        },
      }),
      listProjects: () => [
        ...mutedProjectIds.map((id) => ({ id, name: id })),
        { id: "project-new", name: "New project" },
      ],
      updateFilters,
    });
    const SettingsSection = await loadSettingsSection();
    render(<SettingsSection />);

    fireEvent.click(await screen.findByLabelText("New project"));

    expect(updateFilters).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        "You can mute up to 500 projects. Unmute one to mute another.",
      ),
    ).toBeTruthy();
  });
});
