export const MAX_TITLE_LENGTH = 80;
export const MAX_PROJECT_LENGTH = 30;
export const MAX_DETAIL_LENGTH = 120;
export const PERSONAL_PROJECT_ID = "proj_personal";

export const NOTIFICATION_TAG_PREFIX = "bb-push-notify";

export type NotificationKind = "idle" | "failed" | "pending" | "test";
export type ThreadNotificationKind = Exclude<NotificationKind, "test">;

function compactTextToLength(
  value: string | null,
  maxLength: number,
): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength - 1)}…`
    : compact;
}

export function compactText(value: unknown): string | null {
  if (typeof value === "string") {
    return compactTextToLength(value, MAX_DETAIL_LENGTH);
  }
  // Primitives only: String() on an object/array would render
  // "[object Object]" (or a comma-joined dump) into the notification.
  if (typeof value === "number" || typeof value === "boolean") {
    return compactTextToLength(String(value), MAX_DETAIL_LENGTH);
  }
  return null;
}

export function compactTitle(value: string | null): string | null {
  return compactTextToLength(value, MAX_TITLE_LENGTH);
}

export function notificationTitle(
  projectName: string | null,
  threadTitle: string,
): string {
  const project = compactTextToLength(projectName, MAX_PROJECT_LENGTH);
  if (!project) return compactTitle(threadTitle) ?? "Untitled chat";
  const separator = " · ";
  const availableThreadLength =
    MAX_TITLE_LENGTH - project.length - separator.length;
  const thread =
    compactTextToLength(threadTitle, availableThreadLength) ?? "Untitled chat";
  return `${project}${separator}${thread}`;
}

export function resolveThreadTitle(thread: {
  title: string | null;
  titleFallback: string | null;
}): string {
  return (
    compactTitle(thread.title) ??
    compactTitle(thread.titleFallback) ??
    "Untitled chat"
  );
}

export function threadHref(
  projectId: string | null,
  threadId: string,
): string {
  if (!projectId || projectId === PERSONAL_PROJECT_ID) {
    return `/threads/${encodeURIComponent(threadId)}`;
  }
  return `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`;
}

export function notificationContent(
  kind: ThreadNotificationKind,
  projectName: string | null,
  threadTitle: string,
  detail: string | null,
  showPreview: boolean,
): { title: string; body: string } {
  const status =
    kind === "idle"
      ? "bb agent finished"
      : kind === "pending"
        ? "bb agent is waiting for you"
        : "bb agent failed";
  return {
    title: notificationTitle(projectName, threadTitle),
    body: showPreview && detail ? `${status} — ${detail}` : status,
  };
}

export function notificationTag(
  kind: ThreadNotificationKind,
  threadId: string,
): string {
  return `${NOTIFICATION_TAG_PREFIX}:${kind}:${threadId}`;
}

export function notificationUrgency(
  kind: NotificationKind,
): "high" | "normal" {
  return kind === "failed" || kind === "pending" ? "high" : "normal";
}

/** Whether a turn of `durationMs` (null when unknown) clears the minimum. */
export function meetsMinimumDuration(
  durationMs: number | null,
  minimumSeconds: number,
): boolean {
  if (minimumSeconds <= 0) return true;
  if (durationMs === null) return true;
  return durationMs >= minimumSeconds * 1000;
}

export function isExpiredPushStatus(statusCode: number | null): boolean {
  return statusCode === 404 || statusCode === 410;
}

export function isRetryablePushStatus(statusCode: number | null): boolean {
  return statusCode === null || statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode < 600);
}
