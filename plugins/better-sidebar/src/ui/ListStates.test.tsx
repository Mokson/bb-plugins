// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ListEmpty, ListError, ListLoading, ListNoMatches } from "./ListStates";

/**
 * Every branch asserts its own copy is present *and* that the other three are
 * absent. That is what stops the four states from collapsing into one generic
 * "nothing here" over time, which would leave a user unable to tell a broken
 * plugin from an empty account.
 */
const COPY = {
  loading: /loading threads/i,
  error: /threads could not be loaded/i,
  empty: /no threads yet/i,
  noMatches: /no threads match/i,
} as const;

function expectOnly(branch: keyof typeof COPY) {
  for (const [name, pattern] of Object.entries(COPY)) {
    const found = screen.queryAllByText(pattern).length + queryLabelled(pattern);
    if (name === branch) expect(found, name).toBeGreaterThan(0);
    else expect(found, name).toBe(0);
  }
}

function queryLabelled(pattern: RegExp): number {
  return screen.queryAllByLabelText(pattern).length;
}

afterEach(cleanup);

describe("list states", () => {
  it("loading renders skeleton rows, not an empty container", () => {
    render(<ListLoading />);
    expect(screen.getAllByTestId("thread-skeleton").length).toBeGreaterThan(0);
    expectOnly("loading");
  });

  it("error renders an inline message plus a working retry affordance", () => {
    const onRetry = vi.fn();
    render(<ListError onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expectOnly("error");
  });

  it("empty renders a New-thread hint", () => {
    render(<ListEmpty />);
    expect(screen.getByText(/new thread button/i)).toBeTruthy();
    expectOnly("empty");
  });

  it("no matches names the query the user typed", () => {
    render(<ListNoMatches query="rebase" />);
    expect(screen.getByText(/rebase/)).toBeTruthy();
    expectOnly("noMatches");
  });
});
