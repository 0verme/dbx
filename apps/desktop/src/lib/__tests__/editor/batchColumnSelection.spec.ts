import { describe, expect, it } from "vitest";
import { batchColumnSelectionColumnList, batchColumnSelectionReplaceTo, shouldResolveSqlColumnCompletion } from "@/lib/editor/batchColumnSelection";

describe("batchColumnSelectionColumnList", () => {
  it("keeps a typed qualifier on every projection after the first", () => {
    expect(batchColumnSelectionColumnList(["method", "path", "remark"], "select", "ap")).toBe("method, ap.path, ap.remark");
  });

  it("does not add a qualifier to INSERT target columns", () => {
    expect(batchColumnSelectionColumnList(["id", "name"], "insert", "users")).toBe("id, name");
  });
});

describe("batchColumnSelectionReplaceTo", () => {
  it("consumes the auto-inserted INSERT closing parenthesis", () => {
    expect(batchColumnSelectionReplaceTo({ to: 20, mode: "insert", nextCharacter: ")" })).toBe(21);
  });

  it("keeps the replacement boundary when INSERT has no closing parenthesis", () => {
    expect(batchColumnSelectionReplaceTo({ to: 20, mode: "insert", nextCharacter: "" })).toBe(20);
  });

  it("continues consuming a matching closing identifier quote", () => {
    expect(batchColumnSelectionReplaceTo({ to: 20, mode: "select", nextCharacter: '"', replaceClosingQuote: '"' })).toBe(21);
  });
});

describe("shouldResolveSqlColumnCompletion", () => {
  it("loads fields after SELECT space when a FROM table is already known", () => {
    expect(shouldResolveSqlColumnCompletion({ suggestColumns: true, hasReferencedTables: true, prefix: "", typedActivation: false, selectListColumnContext: true })).toBe(true);
  });

  it("keeps empty non-SELECT column contexts from fetching metadata", () => {
    expect(shouldResolveSqlColumnCompletion({ suggestColumns: true, hasReferencedTables: true, prefix: "", typedActivation: false, selectListColumnContext: false })).toBe(false);
  });
});
