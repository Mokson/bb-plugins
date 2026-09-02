// Synthetic provider-log lines, for the tests that need a log they CONTROL.
//
// Distinct from `log-fixtures.ts`, which serves redacted captures of real
// sessions: those prove the parsers agree with the real formats, and these
// prove the indexer's file handling - resume, reset, prune, budget - by
// pinning session ids, request ids and file sizes that a capture cannot offer.
// Both exist; neither replaces the other.
//
// Kept here rather than re-declared per test file because four indexer tests
// need the same two shapes, and four copies of a log format drift apart.

/**
 * One Claude Code assistant row.
 *
 * `requestId` is the dedupe key the parser collapses on, so distinct ids are
 * what make a file worth several turns rather than one.
 */
export function claudeAssistantLine(
  session: string,
  requestId: string,
  outputTokens = 4,
): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-01T00:00:00.000Z",
    sessionId: session,
    requestId,
    message: {
      model: "claude-opus-5",
      usage: {
        input_tokens: 1,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
        output_tokens: outputTokens,
      },
    },
  })}\n`;
}

/**
 * A minimal Codex rollout: the `session_meta` header the session id lives in,
 * then one `token_count` event. Codex reports a cached read and, on the
 * versions that matter here, no cache write.
 */
export function codexRollout(
  session: string,
  usage: { input: number; cachedInput: number; output: number } = {
    input: 141_707,
    cachedInput: 139_008,
    output: 3_842,
  },
): string {
  return (
    `${JSON.stringify({
      timestamp: "2026-08-29T06:39:35.982Z",
      type: "session_meta",
      payload: { id: session, cwd: "/redacted", model: "gpt-5.6-sol" },
    })}\n` +
    `${JSON.stringify({
      timestamp: "2026-08-29T06:47:06.996Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: usage.input,
            cached_input_tokens: usage.cachedInput,
            output_tokens: usage.output,
            reasoning_output_tokens: 0,
          },
        },
      },
    })}\n`
  );
}
