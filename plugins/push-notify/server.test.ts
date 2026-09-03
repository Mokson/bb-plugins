import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@bb/plugin-sdk";

const webPushMock = vi.hoisted(() => ({
  generateVAPIDKeys: vi.fn(() => ({
    publicKey: "public-key",
    privateKey: "private-key",
  })),
  sendNotification: vi.fn(),
}));

vi.mock("web-push", () => webPushMock);

import plugin, { PUSH_REQUEST_TIMEOUT_MS } from "./server";

type RpcHandler = (input: any) => any;

function createHost(db = new Database(":memory:")) {
  const rpc = new Map<string, RpcHandler>();
  const routes = new Map<string, () => Response>();
  const events = new Map<string, (payload: any) => Promise<void>>();
  const appliedMigrations = new Set<number>();
  const projectGet = vi.fn(async ({ projectId }: { projectId: string }) => ({
    id: projectId,
    name: "Website",
  }));
  const projectList = vi.fn(async () => [
    { id: "project-1", name: "Website" },
    { id: "project-2", name: "Docs" },
  ]);
  const interactionsList = vi.fn(async () => [] as Array<{ status: string }>);
  const bb = {
    pluginId: "push-notify",
    sdk: {
      projects: {
        get: projectGet,
        list: projectList,
      },
      threads: {
        interactions: { list: interactionsList },
      },
    },
    storage: {
      database: () => db,
      migrate(database: Database.Database, statements: string[]) {
        database.transaction(() => {
          statements.forEach((statement, index) => {
            if (appliedMigrations.has(index)) return;
            database.exec(statement);
            appliedMigrations.add(index);
          });
        })();
      },
    },
    rpc: {
      register(_contract: unknown, handlers: Record<string, RpcHandler>) {
        for (const [name, handler] of Object.entries(handlers)) {
          rpc.set(name, handler);
        }
      },
    },
    http: {
      route(method: string, path: string, handler: () => Response) {
        routes.set(`${method} ${path}`, handler);
      },
    },
    events: {
      on(name: string, handler: (payload: any) => Promise<void>) {
        events.set(name, handler);
      },
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as BbPluginApi;

  return {
    bb,
    db,
    events,
    interactionsList,
    projectGet,
    projectList,
    routes,
    rpc,
  };
}

function subscription(endpoint = "https://push.example/device") {
  return {
    endpoint,
    keys: { p256dh: "p256dh", auth: "auth" },
  };
}

describe("web push plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webPushMock.sendNotification.mockResolvedValue({ statusCode: 201 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a fresh migration and preserves VAPID keys and devices on reload", () => {
    const host = createHost();
    plugin(host.bb);
    const firstState = host.rpc.get("getPushState")!(null);
    expect(firstState.vapidPublicKey).toBe("public-key");

    host.rpc.get("registerDevice")!({
      id: "browser-1",
      name: "Laptop",
      subscription: subscription(),
    });
    plugin(host.bb);

    const secondState = host.rpc.get("getPushState")!(null);
    expect(secondState.devices).toMatchObject([
      { id: "browser-1", name: "Laptop", enabled: true },
    ]);
    expect(webPushMock.generateVAPIDKeys).toHaveBeenCalledTimes(1);
    host.db.close();
  });

  it("upserts devices and keeps an endpoint assigned to only one device", () => {
    const host = createHost();
    plugin(host.bb);
    const register = host.rpc.get("registerDevice")!;
    register({
      id: "old-id",
      name: "Old",
      subscription: subscription(),
    });
    register({
      id: "new-id",
      name: "New",
      subscription: subscription(),
    });

    expect(host.rpc.get("getPushState")!(null).devices).toMatchObject([
      { id: "new-id", name: "New" },
    ]);
    host.db.close();
  });

  it("serves the service worker with push and notification click handlers", async () => {
    const host = createHost();
    plugin(host.bb);
    const response = host.routes.get("GET /service-worker.js")!();

    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const source = await response.text();
    expect(source).toContain('self.addEventListener("install"');
    expect(source).toContain("self.skipWaiting()");
    expect(source).toContain("self.clients.claim()");
    expect(source).toContain('self.addEventListener("push"');
    expect(source).not.toContain("icon:");
    host.db.close();
  });

  it("sends focused finished and failed notification content", async () => {
    const host = createHost();
    plugin(host.bb);
    host.rpc.get("registerDevice")!({
      id: "browser-1",
      name: "Laptop",
      subscription: subscription(),
    });

    const thread = {
      id: "thread-1",
      projectId: "project-1",
      title: "Build release",
      titleFallback: null,
      visibility: "visible",
    };
    await host.events.get("thread.idle")!({
      thread,
      lastAssistantText: "All done",
    });

    expect(
      JSON.parse(webPushMock.sendNotification.mock.calls[0]?.[1] as string),
    ).toMatchObject({
      kind: "idle",
      title: "Website · Build release",
      body: "bb agent finished",
      href: "/projects/project-1/threads/thread-1",
    });

    host.rpc.get("updateDevice")!({ id: "browser-1", showPreview: true });
    await host.events.get("thread.failed")!({
      thread,
      error: "Tests failed",
    });

    expect(
      JSON.parse(webPushMock.sendNotification.mock.calls[1]?.[1] as string),
    ).toMatchObject({
      kind: "failed",
      title: "Website · Build release",
      body: "bb agent failed — Tests failed",
      href: "/projects/project-1/threads/thread-1",
    });
    host.db.close();
  });

  it("labels projectless threads and still notifies when project lookup fails", async () => {
    const host = createHost();
    plugin(host.bb);
    host.rpc.get("registerDevice")!({
      id: "browser-1",
      name: "Laptop",
      subscription: subscription(),
    });

    await host.events.get("thread.idle")!({
      thread: {
        id: "personal-thread",
        projectId: "proj_personal",
        title: "Plan the week",
        titleFallback: null,
        visibility: "visible",
      },
      lastAssistantText: "Done",
    });
    expect(
      JSON.parse(webPushMock.sendNotification.mock.calls[0]?.[1] as string),
    ).toMatchObject({
      title: "Personal · Plan the week",
      href: "/threads/personal-thread",
    });
    expect(host.projectGet).not.toHaveBeenCalled();

    host.projectGet.mockRejectedValueOnce(new Error("project unavailable"));
    await host.events.get("thread.failed")!({
      thread: {
        id: "orphaned-thread",
        projectId: "missing-project",
        title: "Recover task",
        titleFallback: null,
        visibility: "visible",
      },
      error: "Stopped",
    });
    expect(
      JSON.parse(webPushMock.sendNotification.mock.calls[1]?.[1] as string),
    ).toMatchObject({
      title: "Recover task",
      href: "/projects/missing-project/threads/orphaned-thread",
    });
    expect(host.bb.log.warn).toHaveBeenCalledWith(
      "Could not resolve project for notification thread orphaned-thread",
    );
    host.db.close();
  });

  it("does not notify for hidden threads", async () => {
    const host = createHost();
    plugin(host.bb);
    host.rpc.get("registerDevice")!({
      id: "browser-1",
      name: "Laptop",
      subscription: subscription(),
    });

    await host.events.get("thread.idle")!({
      thread: {
        id: "thread-1",
        projectId: "project-1",
        title: "Background work",
        titleFallback: null,
        visibility: "hidden",
      },
      lastAssistantText: "All done",
    });

    expect(webPushMock.sendNotification).not.toHaveBeenCalled();
    host.db.close();
  });

  it("sets a request timeout and retries transient failures only twice", async () => {
    vi.useFakeTimers();
    const transient = Object.assign(new Error("unavailable"), {
      statusCode: 503,
    });
    webPushMock.sendNotification
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ statusCode: 201 });
    const host = createHost();
    plugin(host.bb);
    host.rpc.get("registerDevice")!({
      id: "browser-1",
      name: "Laptop",
      subscription: subscription(),
    });

    const sending = host.rpc.get("sendTestNotification")!({
      deviceId: "browser-1",
    });
    await vi.runAllTimersAsync();
    await expect(sending).resolves.toEqual({ sent: true });
    expect(webPushMock.sendNotification).toHaveBeenCalledTimes(3);
    expect(webPushMock.sendNotification.mock.calls[0]?.[2]).toMatchObject({
      timeout: PUSH_REQUEST_TIMEOUT_MS,
      TTL: 43_200,
    });
    host.db.close();
  });

  it("deletes an expired subscription after a push service response", async () => {
    webPushMock.sendNotification.mockRejectedValueOnce(
      Object.assign(new Error("gone"), { statusCode: 410 }),
    );
    const host = createHost();
    plugin(host.bb);
    host.rpc.get("registerDevice")!({
      id: "browser-1",
      name: "Laptop",
      subscription: subscription(),
    });

    await expect(
      host.rpc.get("sendTestNotification")!({ deviceId: "browser-1" }),
    ).rejects.toThrow("Notification subscription expired");
    expect(host.rpc.get("getPushState")!(null).devices).toEqual([]);
    host.db.close();
  });

  it("suppresses short turns and still notifies when the duration is unknown", async () => {
    const host = createHost();
    plugin(host.bb);
    host.rpc.get("registerDevice")!({
      id: "browser-1",
      name: "Laptop",
      subscription: subscription(),
    });
    const thread = {
      id: "thread-1",
      projectId: "project-1",
      parentThreadId: null,
      title: "Quick fix",
      titleFallback: null,
      visibility: "visible",
    };

    await host.events.get("thread.active")!({ thread });
    await host.events.get("thread.idle")!({
      thread,
      lastAssistantText: "Done",
    });
    expect(webPushMock.sendNotification).not.toHaveBeenCalled();

    // No thread.active this time: the plugin cannot know the duration.
    await host.events.get("thread.idle")!({
      thread,
      lastAssistantText: "Done",
    });
    expect(webPushMock.sendNotification).toHaveBeenCalledTimes(1);
    host.db.close();
  });

  it("ignores subagent idle turns but still reports their failures", async () => {
    const host = createHost();
    plugin(host.bb);
    host.rpc.get("registerDevice")!({
      id: "browser-1",
      name: "Laptop",
      subscription: subscription(),
    });
    const thread = {
      id: "subagent-thread",
      projectId: "project-1",
      parentThreadId: "parent-thread",
      title: "Subagent work",
      titleFallback: null,
      visibility: "visible",
    };

    await host.events.get("thread.idle")!({
      thread,
      lastAssistantText: "Done",
    });
    expect(webPushMock.sendNotification).not.toHaveBeenCalled();

    await host.events.get("thread.failed")!({ thread, error: "Crashed" });
    expect(
      JSON.parse(webPushMock.sendNotification.mock.calls[0]?.[1] as string),
    ).toMatchObject({ kind: "failed" });

    host.rpc.get("updateFilters")!({ suppressSubagents: false });
    await host.events.get("thread.idle")!({
      thread,
      lastAssistantText: "Done",
    });
    expect(webPushMock.sendNotification).toHaveBeenCalledTimes(2);
    host.db.close();
  });

  it("sends nothing at all for a muted project, failures included", async () => {
    const host = createHost();
    plugin(host.bb);
    host.rpc.get("registerDevice")!({
      id: "browser-1",
      name: "Laptop",
      subscription: subscription(),
    });
    host.rpc.get("updateFilters")!({ mutedProjectIds: ["project-1"] });
    const thread = {
      id: "thread-1",
      projectId: "project-1",
      parentThreadId: null,
      title: "Muted work",
      titleFallback: null,
      visibility: "visible",
    };

    await host.events.get("thread.failed")!({ thread, error: "Crashed" });
    await host.events.get("thread.idle")!({
      thread,
      lastAssistantText: "Done",
    });
    expect(webPushMock.sendNotification).not.toHaveBeenCalled();
    host.db.close();
  });

  it("sends a waiting notification instead of a finished one", async () => {
    const host = createHost();
    plugin(host.bb);
    host.rpc.get("registerDevice")!({
      id: "browser-1",
      name: "Laptop",
      subscription: subscription(),
    });
    const thread = {
      id: "thread-1",
      projectId: "project-1",
      parentThreadId: null,
      title: "Build release",
      titleFallback: null,
      visibility: "visible",
    };

    host.interactionsList.mockResolvedValueOnce([{ status: "pending" }]);
    // Short turn: the duration filter must not hide a waiting agent.
    await host.events.get("thread.active")!({ thread });
    await host.events.get("thread.idle")!({
      thread,
      lastAssistantText: "Approve the plan?",
    });

    expect(webPushMock.sendNotification).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(webPushMock.sendNotification.mock.calls[0]?.[1] as string),
    ).toMatchObject({
      kind: "pending",
      title: "Website · Build release",
      body: "bb agent is waiting for you",
      tag: "bb-push-notify:pending:thread-1",
    });
    expect(webPushMock.sendNotification.mock.calls[0]?.[2]).toMatchObject({
      urgency: "high",
    });
    host.db.close();
  });

  it("stores filter defaults and exposes projects to the settings UI", async () => {
    const host = createHost();
    plugin(host.bb);
    expect(host.rpc.get("getPushState")!(null).filters).toEqual({
      suppressSubagents: true,
      minTurnSeconds: 30,
      mutedProjectIds: [],
    });

    host.rpc.get("updateFilters")!({ minTurnSeconds: 0 });
    plugin(host.bb);
    expect(host.rpc.get("getPushState")!(null).filters.minTurnSeconds).toBe(0);
    await expect(host.rpc.get("listProjects")!(null)).resolves.toEqual([
      { id: "project-1", name: "Website" },
      { id: "project-2", name: "Docs" },
    ]);

    host.projectList.mockRejectedValueOnce(new Error("unavailable"));
    await expect(host.rpc.get("listProjects")!(null)).resolves.toEqual([]);
    host.db.close();
  });

  it("still sends the finished push when the pending lookup hangs", async () => {
    vi.useFakeTimers();
    const host = createHost();
    plugin(host.bb);
    host.rpc.get("registerDevice")!({
      id: "browser-1",
      name: "Laptop",
      subscription: subscription(),
    });
    host.interactionsList.mockImplementationOnce(
      () => new Promise(() => undefined),
    );

    const idle = host.events.get("thread.idle")!({
      thread: {
        id: "thread-1",
        projectId: "project-1",
        parentThreadId: null,
        title: "Build release",
        titleFallback: null,
        visibility: "visible",
      },
      lastAssistantText: "All done",
    });
    await vi.runAllTimersAsync();
    await idle;

    expect(
      JSON.parse(webPushMock.sendNotification.mock.calls[0]?.[1] as string),
    ).toMatchObject({ kind: "idle" });
    expect(host.bb.log.warn).toHaveBeenCalledWith(
      "Could not read pending interactions for thread thread-1",
    );
    host.db.close();
  });

  it("falls back to the default filters when the filter read fails", async () => {
    const host = createHost();
    plugin(host.bb);
    host.rpc.get("registerDevice")!({
      id: "browser-1",
      name: "Laptop",
      subscription: subscription(),
    });
    host.rpc.get("updateFilters")!({ mutedProjectIds: ["project-1"] });
    host.db.exec("DROP TABLE push_metadata");

    await host.events.get("thread.failed")!({
      thread: {
        id: "thread-1",
        projectId: "project-1",
        parentThreadId: null,
        title: "Build release",
        titleFallback: null,
        visibility: "visible",
      },
      error: "Crashed",
    });

    expect(
      JSON.parse(webPushMock.sendNotification.mock.calls[0]?.[1] as string),
    ).toMatchObject({ kind: "failed" });
    expect(host.bb.log.warn).toHaveBeenCalledWith(
      "Could not read notification filters; using defaults",
    );
    host.db.close();
  });
});
