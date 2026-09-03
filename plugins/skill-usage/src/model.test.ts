import { describe, expect, it } from "vitest";
import { collapseInvocations, countBySkill, parseSkillEvent, rollup } from "./model";

function event(overrides: {
  type: "item/started" | "item/completed";
  seq: number;
  createdAt?: number;
  itemId?: string;
  threadId?: string;
  tool?: string;
  skill?: string | null;
  args?: string;
  status?: string;
  result?: string;
}) {
  const args: Record<string, unknown> = {};
  if (overrides.skill !== null) args["skill"] = overrides.skill ?? "grilling";
  if (overrides.args !== undefined) args["args"] = overrides.args;
  return {
    id: `evt-${overrides.seq}`,
    threadId: overrides.threadId ?? "thr_a",
    seq: overrides.seq,
    createdAt: overrides.createdAt ?? 1_000,
    type: overrides.type,
    data: {
      item: {
        type: "toolCall",
        id: overrides.itemId ?? "call-1",
        tool: overrides.tool ?? "Skill",
        arguments: args,
        status: overrides.status ?? "pending",
        result: overrides.result,
      },
    },
  };
}

describe("parseSkillEvent", () => {
  it("reads name, args, status and result from a completed Skill call", () => {
    const parsed = parseSkillEvent(
      event({
        type: "item/completed",
        seq: 30,
        createdAt: 5_000,
        args: "--deep",
        status: "completed",
        result: "Launching skill: grilling",
      }),
    );
    expect(parsed).toEqual({
      itemId: "call-1",
      threadId: "thr_a",
      seq: 30,
      createdAt: 5_000,
      skill: "grilling",
      args: "--deep",
      status: "completed",
      result: "Launching skill: grilling",
      source: "tool",
    });
  });

  it("treats pending and unknown statuses as running", () => {
    expect(parseSkillEvent(event({ type: "item/started", seq: 1 }))?.status).toBe("running");
    expect(parseSkillEvent(event({ type: "item/started", seq: 1, status: "weird" }))?.status).toBe(
      "running",
    );
  });

  it("skips non-Skill tools, other event types, and malformed rows", () => {
    expect(parseSkillEvent(event({ type: "item/completed", seq: 1, tool: "Bash" }))).toBeNull();
    expect(parseSkillEvent({ ...event({ type: "item/started", seq: 1 }), type: "turn/started" }))
      .toBeNull();
    expect(parseSkillEvent(event({ type: "item/started", seq: 1, skill: null }))).toBeNull();
    expect(parseSkillEvent(null)).toBeNull();
    expect(parseSkillEvent({ type: "item/completed", data: "nonsense" })).toBeNull();
  });
});

describe("collapseInvocations", () => {
  it("merges the started and completed rows of one call", () => {
    const result = collapseInvocations([
      event({ type: "item/started", seq: 10, createdAt: 1_000 }),
      event({ type: "item/completed", seq: 11, createdAt: 2_000, status: "completed", result: "ok" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ seq: 10, createdAt: 1_000, status: "completed", result: "ok" });
  });

  it("keeps a terminal status even when the completed row arrives first", () => {
    const result = collapseInvocations([
      event({ type: "item/completed", seq: 11, status: "failed", result: "Unknown skill: qa" }),
      event({ type: "item/started", seq: 10 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("failed");
    expect(result[0]?.seq).toBe(10);
  });

  it("leaves a started call without its pair as running", () => {
    const result = collapseInvocations([event({ type: "item/started", seq: 10 })]);
    expect(result[0]?.status).toBe("running");
  });

  it("keeps same-named calls in different threads apart", () => {
    const result = collapseInvocations([
      event({ type: "item/started", seq: 10, threadId: "thr_a" }),
      event({ type: "item/started", seq: 10, threadId: "thr_b" }),
    ]);
    expect(result).toHaveLength(2);
  });

  it("orders chronologically by the started sequence", () => {
    const result = collapseInvocations([
      event({ type: "item/started", seq: 30, itemId: "c2", skill: "pr" }),
      event({ type: "item/started", seq: 10, itemId: "c1", skill: "grilling" }),
    ]);
    expect(result.map((item) => item.skill)).toEqual(["grilling", "pr"]);
  });
});

describe("rollup", () => {
  const invocations = collapseInvocations([
    event({ type: "item/completed", seq: 1, itemId: "a", threadId: "t1", skill: "pr", createdAt: 10, status: "completed" }),
    event({ type: "item/completed", seq: 2, itemId: "b", threadId: "t1", skill: "pr", createdAt: 20, status: "failed" }),
    event({ type: "item/completed", seq: 3, itemId: "c", threadId: "t2", skill: "pr", createdAt: 30, status: "completed" }),
    event({ type: "item/completed", seq: 4, itemId: "d", threadId: "t2", skill: "qa", createdAt: 40, status: "completed" }),
  ]);

  it("counts totals, failures and last use per skill", () => {
    const rows = rollup(invocations);
    expect(rows[0]).toMatchObject({ skill: "pr", total: 3, failures: 1, lastUsedAt: 30 });
    expect(rows[1]).toMatchObject({ skill: "qa", total: 1, failures: 0, lastUsedAt: 40 });
  });

  it("groups the threads that used each skill, newest first", () => {
    const rows = rollup(invocations);
    expect(rows[0]?.threads).toEqual([
      { threadId: "t2", count: 1, lastUsedAt: 30 },
      { threadId: "t1", count: 2, lastUsedAt: 20 },
    ]);
  });

  it("breaks a count tie by name", () => {
    const rows = rollup(
      collapseInvocations([
        event({ type: "item/started", seq: 1, itemId: "x", skill: "zeta" }),
        event({ type: "item/started", seq: 2, itemId: "y", skill: "alpha" }),
      ]),
    );
    expect(rows.map((row) => row.skill)).toEqual(["alpha", "zeta"]);
  });
});

describe("countBySkill", () => {
  it("orders by count then name", () => {
    const counts = countBySkill(
      collapseInvocations([
        event({ type: "item/started", seq: 1, itemId: "a", skill: "pr" }),
        event({ type: "item/started", seq: 2, itemId: "b", skill: "pr" }),
        event({ type: "item/started", seq: 3, itemId: "c", skill: "qa" }),
      ]),
    );
    expect(counts).toEqual([
      { skill: "pr", count: 2 },
      { skill: "qa", count: 1 },
    ]);
  });
});
