// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import { readStore, writeStore } from "./local-store";

const schema = z.array(z.string());

beforeEach(() => {
  window.localStorage.clear();
});

describe("local-store", () => {
  it("round-trips a valid value", () => {
    writeStore("collapse:v1", ["a", "b"]);
    expect(readStore("collapse:v1", schema, [])).toEqual(["a", "b"]);
  });

  it("namespaces the key under better-sidebar:", () => {
    writeStore("collapse:v1", ["a"]);
    expect(window.localStorage.getItem("better-sidebar:collapse:v1")).not.toBeNull();
  });

  it("falls back to the default on a missing key", () => {
    expect(readStore("nope", schema, ["fallback"])).toEqual(["fallback"]);
  });

  it("falls back to the default on malformed JSON rather than throwing", () => {
    window.localStorage.setItem("better-sidebar:collapse:v1", "{not json");
    expect(() => readStore("collapse:v1", schema, ["fallback"])).not.toThrow();
    expect(readStore("collapse:v1", schema, ["fallback"])).toEqual(["fallback"]);
  });

  it("falls back to the default when the stored shape fails the schema", () => {
    window.localStorage.setItem("better-sidebar:collapse:v1", JSON.stringify({ wrong: "shape" }));
    expect(readStore("collapse:v1", schema, ["fallback"])).toEqual(["fallback"]);
  });
});
