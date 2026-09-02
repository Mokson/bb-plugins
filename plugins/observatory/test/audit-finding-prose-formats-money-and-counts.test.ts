// Invariant: a finding is a sentence a human reads, so the numbers in it are
// rounded to the precision the decision needs. Raw float arithmetic leaked
// into the prose as "costUsd 373.6198315 is over the 7d median
// 1.9738959999999999", which is a reader doing digit-counting to learn what
// "much bigger" already said.
import { describe, expect, it } from "vitest";
import { metricText } from "../src/audit/pack.js";

describe("audit finding prose", () => {
  it("renders money to the cent", () => {
    expect(metricText("costUsd", 373.6198315)).toBe("373.62");
    expect(metricText("costUsd", 1.9738959999999999)).toBe("1.97");
  });

  it("renders counts and tokens with thousands separators", () => {
    expect(metricText("tokens", 1234567.4)).toBe("1,234,567");
    expect(metricText("toolCalls", 1016)).toBe("1,016");
    expect(metricText("turns", 7)).toBe("7");
  });

  it("keeps an unknown distinct from a zero", () => {
    expect(metricText("costUsd", null)).toBe("n/a");
    expect(metricText("costUsd", 0)).toBe("0.00");
  });
});
