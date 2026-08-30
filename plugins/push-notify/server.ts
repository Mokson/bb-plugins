import { createHash, randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import webPush, { type PushSubscription } from "web-push";
import { z } from "zod";
import {
  compactText,
  isExpiredPushStatus,
  isRetryablePushStatus,
  meetsMinimumDuration,
  NOTIFICATION_TAG_PREFIX,
  notificationContent,
  notificationTag,
  notificationUrgency,
  type NotificationKind,
  PERSONAL_PROJECT_ID,
  resolveThreadTitle,
  type ThreadNotificationKind,
  threadHref,
} from "./notification-policy";

const PUSH_TTL_SECONDS = 12 * 60 * 60;
export const PUSH_REQUEST_TIMEOUT_MS = 12_000;
export const PUSH_DELIVERY_BUDGET_MS = 45_000;
const MAX_PARALLEL_SENDS = 4;
const PUSH_RETRY_DELAYS_MS = [1_000, 3_000] as const;
const VAPID_SUBJECT = "https://github.com/Mokson/bb-plugins";
const DEFAULT_MIN_TURN_SECONDS = 30;
const MAX_MIN_TURN_SECONDS = 3600;
const PENDING_LOOKUP_TIMEOUT_MS = 2_000;

const subscriptionSchema = z
  .object({
    endpoint: z.string().url().max(4096),
    keys: z
      .object({
        p256dh: z.string().min(1).max(2048),
        auth: z.string().min(1).max(2048),
      })
      .strict(),
  })
  .strict();

const deviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  notifyIdle: z.boolean(),
  notifyFailed: z.boolean(),
  notifyPending: z.boolean(),
  showPreview: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const deviceIdSchema = z.string().min(1).max(200);
const deviceNameSchema = z.string().trim().min(1).max(80);
const deviceUpdateSchema = z
  .object({
    id: deviceIdSchema,
    name: deviceNameSchema.optional(),
    enabled: z.boolean().optional(),
    notifyIdle: z.boolean().optional(),
    notifyFailed: z.boolean().optional(),
    notifyPending: z.boolean().optional(),
    showPreview: z.boolean().optional(),
  })
  .strict()
  .refine(
    ({ name, enabled, notifyIdle, notifyFailed, notifyPending, showPreview }) =>
      name !== undefined ||
      enabled !== undefined ||
      notifyIdle !== undefined ||
      notifyFailed !== undefined ||
      notifyPending !== undefined ||
      showPreview !== undefined,
    { message: "At least one device field is required" },
  );

const filtersSchema = z.object({
  suppressSubagents: z.boolean(),
  minTurnSeconds: z.number().int().min(0).max(MAX_MIN_TURN_SECONDS),
  mutedProjectIds: z.array(z.string().min(1).max(200)).max(500),
});

const filtersUpdateSchema = z
  .object({
    suppressSubagents: z.boolean().optional(),
    minTurnSeconds: z.number().int().min(0).max(MAX_MIN_TURN_SECONDS).optional(),
    mutedProjectIds: z.array(z.string().min(1).max(200)).max(500).optional(),
  })
  .strict()
  .refine(
    ({ suppressSubagents, minTurnSeconds, mutedProjectIds }) =>
      suppressSubagents !== undefined ||
      minTurnSeconds !== undefined ||
      mutedProjectIds !== undefined,
    { message: "At least one filter field is required" },
  );

export const rpcContract = defineRpcContract({
  getPushState: {
    input: z.null(),
    output: z.object({
      vapidPublicKey: z.string(),
      workerUrl: z.string(),
      workerScope: z.string(),
      devices: z.array(deviceSchema),
      filters: filtersSchema,
    }),
  },
  updateFilters: {
    input: filtersUpdateSchema,
    output: filtersSchema,
  },
  listProjects: {
    input: z.null(),
    output: z.array(z.object({ id: z.string(), name: z.string() })),
  },
  registerDevice: {
    input: z
      .object({
        id: deviceIdSchema,
        name: deviceNameSchema,
        subscription: subscriptionSchema,
      })
      .strict(),
    output: deviceSchema,
  },
  updateDevice: {
    input: deviceUpdateSchema,
    output: deviceSchema,
  },
  removeDevice: {
    input: z.object({ id: deviceIdSchema }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  sendTestNotification: {
    input: z.object({ deviceId: deviceIdSchema }).strict(),
    output: z.object({ sent: z.literal(true) }),
  },
});

type PushDeviceRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  name: string;
  enabled: number;
  notify_idle: number;
  notify_failed: number;
  notify_pending: number;
  show_preview: number;
  created_at: number;
  updated_at: number;
};

type NotificationFilters = {
  suppressSubagents: boolean;
  minTurnSeconds: number;
  mutedProjectIds: string[];
};

type NotificationPayload = {
  version: 1;
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  href: string | null;
  tag: string;
};

function toDevice(row: PushDeviceRow) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    notifyIdle: row.notify_idle === 1,
    notifyFailed: row.notify_failed === 1,
    notifyPending: row.notify_pending === 1,
    showPreview: row.show_preview === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function subscriptionFor(row: PushDeviceRow): PushSubscription {
  return {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
}

function pushStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("statusCode" in error))
    return null;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : null;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function eachWithConcurrency<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const value = values[nextIndex] as T;
        nextIndex += 1;
        await task(value);
      }
    }),
  );
}

function serviceWorkerSource(): string {
  return `
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  event.waitUntil((async () => {
    let payload;
    try { payload = event.data.json(); } catch { return; }
    if (!payload || payload.version !== 1) return;
    await self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      tag: payload.tag,
      data: { href: payload.href, id: payload.id },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const href = event.notification.data && event.notification.data.href;
    const target = typeof href === "string" ? new URL(href, self.location.origin) : new URL("/", self.location.origin);
    if (target.origin !== self.location.origin) return;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows[0];
    if (existing) {
      if ("navigate" in existing) await existing.navigate(target.href);
      await existing.focus();
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
`.trimStart();
}

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS push_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_devices (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      notify_idle INTEGER NOT NULL DEFAULT 1,
      notify_failed INTEGER NOT NULL DEFAULT 1,
      show_preview INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );`,
    `ALTER TABLE push_devices
      ADD COLUMN notify_pending INTEGER NOT NULL DEFAULT 1;`,
  ]);

  const readMetadata = db.prepare(
    "SELECT value FROM push_metadata WHERE key = ?",
  );
  const writeMetadata = db.prepare(
    "INSERT INTO push_metadata (key, value) VALUES (?, ?)",
  );

  const upsertMetadata = db.prepare(
    `INSERT INTO push_metadata (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  function metadataValue(key: string): string | undefined {
    return (readMetadata.get(key) as { value: string } | undefined)?.value;
  }

  const DEFAULT_FILTERS: NotificationFilters = {
    suppressSubagents: true,
    minTurnSeconds: DEFAULT_MIN_TURN_SECONDS,
    mutedProjectIds: [],
  };

  /** Never throws: a failed read falls back to the default filters. */
  function readFilters(): NotificationFilters {
    try {
      return readStoredFilters();
    } catch {
      bb.log.warn("Could not read notification filters; using defaults");
      return DEFAULT_FILTERS;
    }
  }

  function readStoredFilters(): NotificationFilters {
    const minTurnSeconds = Number(metadataValue("min_turn_seconds"));
    let mutedProjectIds: string[] = [];
    const rawMuted = metadataValue("muted_project_ids");
    if (rawMuted) {
      try {
        const parsed: unknown = JSON.parse(rawMuted);
        if (Array.isArray(parsed)) {
          mutedProjectIds = parsed.filter(
            (value): value is string => typeof value === "string",
          );
        }
      } catch {
        bb.log.warn("Ignoring unreadable muted project list");
      }
    }
    return {
      suppressSubagents: metadataValue("suppress_subagents") !== "0",
      minTurnSeconds:
        Number.isInteger(minTurnSeconds) &&
        minTurnSeconds >= 0 &&
        minTurnSeconds <= MAX_MIN_TURN_SECONDS
          ? minTurnSeconds
          : DEFAULT_MIN_TURN_SECONDS,
      mutedProjectIds,
    };
  }

  let publicKey = (
    readMetadata.get("vapid_public_key") as { value: string } | undefined
  )?.value;
  let privateKey = (
    readMetadata.get("vapid_private_key") as { value: string } | undefined
  )?.value;

  if (!publicKey || !privateKey) {
    const keys = webPush.generateVAPIDKeys();
    db.transaction(() => {
      db.prepare("DELETE FROM push_metadata WHERE key LIKE 'vapid_%'").run();
      writeMetadata.run("vapid_public_key", keys.publicKey);
      writeMetadata.run("vapid_private_key", keys.privateKey);
    })();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
  }

  const vapidDetails = {
    subject: VAPID_SUBJECT,
    publicKey,
    privateKey,
  };
  const workerUrl = `/api/v1/plugins/${encodeURIComponent(bb.pluginId)}/http/service-worker.js`;
  const workerScope = workerUrl.slice(0, workerUrl.lastIndexOf("/") + 1);

  const listDevicesStatement = db.prepare(
    "SELECT * FROM push_devices ORDER BY updated_at DESC",
  );
  const getDeviceStatement = db.prepare(
    "SELECT * FROM push_devices WHERE id = ?",
  );
  const deleteDeviceStatement = db.prepare(
    "DELETE FROM push_devices WHERE id = ?",
  );

  function getDevice(id: string): PushDeviceRow {
    const row = getDeviceStatement.get(id) as PushDeviceRow | undefined;
    if (!row) throw new Error("Notification device not found");
    return row;
  }

  async function send(row: PushDeviceRow, payload: NotificationPayload) {
    const startedAt = Date.now();
    const options = {
      TTL: PUSH_TTL_SECONDS,
      timeout: PUSH_REQUEST_TIMEOUT_MS,
      urgency: notificationUrgency(payload.kind),
      topic: createHash("sha256")
        .update(payload.tag)
        .digest("base64url")
        .slice(0, 32),
      vapidDetails,
    };

    for (let attempt = 0; ; attempt += 1) {
      try {
        await webPush.sendNotification(
          subscriptionFor(row),
          JSON.stringify(payload),
          options,
        );
        return true;
      } catch (error) {
        const statusCode = pushStatusCode(error);
        if (isExpiredPushStatus(statusCode)) {
          deleteDeviceStatement.run(row.id);
          bb.log.info(`Removed expired notification device ${row.id}`);
          return false;
        }
        const delayMs = PUSH_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined || !isRetryablePushStatus(statusCode)) {
          throw error;
        }
        if (Date.now() - startedAt + delayMs >= PUSH_DELIVERY_BUDGET_MS) {
          throw error;
        }
        bb.log.warn(
          `Transient push failure for device ${row.id}${statusCode ? ` (${statusCode})` : ""}; retrying`,
        );
        await wait(delayMs);
      }
    }
  }

  async function notifyDevices(
    kind: ThreadNotificationKind,
    thread: { id: string; projectId: string; title: string | null; titleFallback: string | null },
    detail: string | null,
  ) {
    const preferenceColumn =
      kind === "idle"
        ? "notify_idle"
        : kind === "pending"
          ? "notify_pending"
          : "notify_failed";
    const rows = db
      .prepare(
        `SELECT * FROM push_devices WHERE enabled = 1 AND ${preferenceColumn} = 1`,
      )
      .all() as PushDeviceRow[];
    if (rows.length === 0) return;

    let projectName: string | null = null;
    if (thread.projectId === PERSONAL_PROJECT_ID) {
      projectName = "Personal";
    } else {
      try {
        const project = await bb.sdk.projects.get({
          projectId: thread.projectId,
        });
        projectName = compactText(project.name);
      } catch {
        bb.log.warn(
          `Could not resolve project for notification thread ${thread.id}`,
        );
      }
    }
    const threadTitle = resolveThreadTitle(thread);
    const href = threadHref(thread.projectId, thread.id);
    await eachWithConcurrency(rows, MAX_PARALLEL_SENDS, async (row) => {
      const content = notificationContent(
        kind,
        projectName,
        threadTitle,
        detail,
        row.show_preview === 1,
      );
      const payload: NotificationPayload = {
        version: 1,
        id: randomUUID(),
        kind,
        title: content.title,
        body: content.body,
        href,
        tag: notificationTag(kind, thread.id),
      };
      try {
        await send(row, payload);
      } catch (error) {
        bb.log.warn(
          `Push delivery failed for device ${row.id}${pushStatusCode(error) ? ` (${pushStatusCode(error)})` : ""}`,
        );
      }
    });
  }

  /**
   * `ThreadResponse` carries no pending-interaction flag, so ask the host
   * whether the agent stopped on a question or an approval. A lookup failure
   * falls back to the ordinary finished notification.
   */
  async function hasPendingInteraction(threadId: string): Promise<boolean> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const interactions = await Promise.race([
        bb.sdk.threads.interactions.list({ threadId }),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("Pending interaction lookup timed out")),
            PENDING_LOOKUP_TIMEOUT_MS,
          );
          timeoutId.unref?.();
        }),
      ]);
      return interactions.some(
        (interaction) => interaction.status === "pending",
      );
    } catch {
      bb.log.warn(`Could not read pending interactions for thread ${threadId}`);
      return false;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  // Turn starts, kept only between thread.active and the event that ends the
  // turn, so a restarted plugin simply reports an unknown duration.
  const turnStartedAt = new Map<string, number>();

  bb.events.on("thread.active", ({ thread }) => {
    turnStartedAt.set(thread.id, Date.now());
  });

  bb.events.on("thread.archived", ({ thread }) => {
    turnStartedAt.delete(thread.id);
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    turnStartedAt.delete(thread.id);
  });

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const startedAt = turnStartedAt.get(thread.id);
    turnStartedAt.delete(thread.id);
    if (thread.visibility !== "visible") return;
    const filters = readFilters();
    if (filters.mutedProjectIds.includes(thread.projectId)) return;
    if (filters.suppressSubagents && thread.parentThreadId != null) return;
    if (await hasPendingInteraction(thread.id)) {
      await notifyDevices("pending", thread, compactText(lastAssistantText));
      return;
    }
    const durationMs = startedAt === undefined ? null : Date.now() - startedAt;
    if (!meetsMinimumDuration(durationMs, filters.minTurnSeconds)) return;
    await notifyDevices("idle", thread, compactText(lastAssistantText));
  });

  bb.events.on("thread.failed", async ({ thread, error }) => {
    turnStartedAt.delete(thread.id);
    if (thread.visibility !== "visible") return;
    if (readFilters().mutedProjectIds.includes(thread.projectId)) return;
    await notifyDevices("failed", thread, compactText(error));
  });

  bb.http.route("GET", "/service-worker.js", () => {
    return new Response(serviceWorkerSource(), {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });

  bb.rpc.register(rpcContract, {
    getPushState() {
      return {
        vapidPublicKey: publicKey,
        workerUrl,
        workerScope,
        devices: (listDevicesStatement.all() as PushDeviceRow[]).map(toDevice),
        filters: readFilters(),
      };
    },

    updateFilters(changes) {
      const current = readFilters();
      const next: NotificationFilters = {
        suppressSubagents: changes.suppressSubagents ?? current.suppressSubagents,
        minTurnSeconds: changes.minTurnSeconds ?? current.minTurnSeconds,
        mutedProjectIds: changes.mutedProjectIds ?? current.mutedProjectIds,
      };
      db.transaction(() => {
        upsertMetadata.run(
          "suppress_subagents",
          next.suppressSubagents ? "1" : "0",
        );
        upsertMetadata.run("min_turn_seconds", String(next.minTurnSeconds));
        upsertMetadata.run(
          "muted_project_ids",
          JSON.stringify(next.mutedProjectIds),
        );
      })();
      return next;
    },

    async listProjects() {
      try {
        const projects = await bb.sdk.projects.list();
        return projects.map((project) => ({
          id: project.id,
          name: project.name,
        }));
      } catch {
        bb.log.warn("Could not list projects for notification filters");
        return [];
      }
    },

    registerDevice({ id, name, subscription }) {
      const now = Date.now();
      db.transaction(() => {
        db.prepare("DELETE FROM push_devices WHERE endpoint = ? AND id <> ?").run(
          subscription.endpoint,
          id,
        );
        db.prepare(
          `INSERT INTO push_devices (
            id, endpoint, p256dh, auth, name, enabled,
            notify_idle, notify_failed, notify_pending, show_preview,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 1, 1, 1, 1, 0, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            endpoint = excluded.endpoint,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            name = excluded.name,
            enabled = 1,
            updated_at = excluded.updated_at`,
        ).run(
          id,
          subscription.endpoint,
          subscription.keys.p256dh,
          subscription.keys.auth,
          name,
          now,
          now,
        );
      })();
      return toDevice(getDevice(id));
    },

    updateDevice({ id, ...changes }) {
      const current = getDevice(id);
      db.prepare(
        `UPDATE push_devices SET
          name = ?, enabled = ?, notify_idle = ?, notify_failed = ?,
          notify_pending = ?, show_preview = ?, updated_at = ?
        WHERE id = ?`,
      ).run(
        changes.name ?? current.name,
        (changes.enabled ?? (current.enabled === 1)) ? 1 : 0,
        (changes.notifyIdle ?? (current.notify_idle === 1)) ? 1 : 0,
        (changes.notifyFailed ?? (current.notify_failed === 1)) ? 1 : 0,
        (changes.notifyPending ?? (current.notify_pending === 1)) ? 1 : 0,
        (changes.showPreview ?? (current.show_preview === 1)) ? 1 : 0,
        Date.now(),
        id,
      );
      return toDevice(getDevice(id));
    },

    removeDevice({ id }) {
      const result = deleteDeviceStatement.run(id);
      return { removed: result.changes > 0 };
    },

    async sendTestNotification({ deviceId }) {
      const row = getDevice(deviceId);
      if (row.enabled !== 1) throw new Error("Notification device is disabled");
      const sent = await send(row, {
        version: 1,
        id: randomUUID(),
        kind: "test",
        title: "bb agent notifications enabled",
        body: "Notifications are working on this device.",
        href: null,
        tag: `${NOTIFICATION_TAG_PREFIX}:test:${randomUUID()}`,
      });
      if (!sent) throw new Error("Notification subscription expired");
      return { sent: true as const };
    },
  });

  bb.log.info("Push Notify notification listener loaded");
}
