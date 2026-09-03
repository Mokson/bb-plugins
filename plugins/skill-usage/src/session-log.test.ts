import { describe, expect, it } from "vitest";
import { parseCommandInvocations } from "./session-log";

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

function user(text: string, overrides: Record<string, unknown> = {}): string {
  return line({
    type: "user",
    uuid: "u1",
    timestamp: "2026-09-03T17:55:27.726Z",
    message: { content: text },
    ...overrides,
  });
}

const COMMAND = "<command-message>debug</command-message>\n<command-name>/debug</command-name>";
const SKILL_BODY = "Base directory for this skill: /Users/mokson/.claude/skills/debug\n\n# Debug";

describe("parseCommandInvocations", () => {
  it("pairs a slash command with the skill directory that follows it", () => {
    const result = parseCommandInvocations([user(COMMAND), user(SKILL_BODY, { uuid: "u2" })], "t1");
    expect(result).toEqual([
      {
        itemId: "u1",
        threadId: "t1",
        seq: 0,
        createdAt: Date.parse("2026-09-03T17:55:27.726Z"),
        skill: "debug",
        args: null,
        status: "completed",
        result: null,
        source: "command",
      },
    ]);
  });

  it("keeps command args", () => {
    const result = parseCommandInvocations(
      [user(`${COMMAND}\n<command-args>find other issues</command-args>`), user(SKILL_BODY)],
      "t1",
    );
    expect(result[0]?.args).toBe("find other issues");
  });

  it("drops a built-in command that loads no skill", () => {
    const result = parseCommandInvocations(
      [user("<command-name>/clear</command-name>"), user("some other message")],
      "t1",
    );
    expect(result).toEqual([]);
  });

  it("drops a skill directory with no command before it, which is a tool call", () => {
    // BB already records Skill tool calls as events; counting the log entry
    // too would double every tool-invoked skill.
    const result = parseCommandInvocations([user(SKILL_BODY)], "t1");
    expect(result).toEqual([]);
  });

  it("does not let one skill body satisfy two commands", () => {
    const result = parseCommandInvocations(
      [
        user(COMMAND, { uuid: "a" }),
        user(SKILL_BODY),
        user("<command-name>/clear</command-name>", { uuid: "b" }),
      ],
      "t1",
    );
    expect(result.map((item) => item.itemId)).toEqual(["a"]);
  });

  it("reads content blocks as well as plain strings", () => {
    const blocks = line({
      type: "user",
      uuid: "u9",
      timestamp: "2026-09-03T17:55:27.726Z",
      message: { content: [{ type: "text", text: COMMAND }] },
    });
    const result = parseCommandInvocations([blocks, user(SKILL_BODY)], "t1");
    expect(result[0]?.skill).toBe("debug");
  });

  it("takes the skill name from the last path segment", () => {
    const nested = user(
      "Base directory for this skill: /var/folders/x/skills/bb-plugin-authoring",
      { uuid: "u3" },
    );
    const result = parseCommandInvocations(
      [user("<command-name>/bb-plugin-authoring</command-name>"), nested],
      "t1",
    );
    expect(result[0]?.skill).toBe("bb-plugin-authoring");
  });

  it("ignores assistant entries, blank lines and truncated JSON", () => {
    const result = parseCommandInvocations(
      [
        "",
        "{not json",
        line({ type: "assistant", uuid: "a1", message: { content: COMMAND } }),
        user(COMMAND),
        user(SKILL_BODY),
      ],
      "t1",
    );
    expect(result).toHaveLength(1);
  });

  it("survives an entry with no uuid or timestamp", () => {
    const result = parseCommandInvocations(
      [user(COMMAND, { uuid: "u4", timestamp: undefined }), user(SKILL_BODY)],
      "t1",
    );
    expect(result[0]?.createdAt).toBe(0);
  });
});
