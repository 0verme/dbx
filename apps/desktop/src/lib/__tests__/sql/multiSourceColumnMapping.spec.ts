import { describe, expect, it } from "vitest";
import { analyzeEditableQueryEditability, sourceColumnsForResult } from "@/lib/sql/sqlAnalysis";

/**
 * A joined result is editable-only when exactly one source provides row
 * identity; the display mapping must still resolve every result column back to
 * its physical source column so the data grid can show column comments.
 */
describe("multi-source result column mapping", () => {
  it("parses a JOIN as multi-source with per-source columns", () => {
    const result = analyzeEditableQueryEditability("SELECT a.id, a.user_id, b.name FROM orders a JOIN users b ON a.user_id = b.id");
    expect(result.editable).toBe(true);
    if (!result.editable) return;

    const sources = result.analysis.sources!;
    expect(sources.map((source) => source.tableName)).toEqual(["orders", "users"]);
    expect(result.analysis.columns.map((column) => column.resultName)).toEqual(["id", "user_id", "name"]);
    expect(result.analysis.columns.map((column) => column.sourceKey)).toEqual(["a:0", "a:0", "b:1"]);
  });

  it("maps each JOIN result column to its source column per source", () => {
    const result = analyzeEditableQueryEditability("SELECT a.id, a.user_id, b.name FROM orders a JOIN users b ON a.user_id = b.id");
    expect(result.editable).toBe(true);
    if (!result.editable) return;

    const analysis = result.analysis;
    const sources = analysis.sources!;
    const resultColumns = ["id", "user_id", "name"];

    const ordersMapping = sourceColumnsForResult(analysis, resultColumns, sources[0]!.key);
    const usersMapping = sourceColumnsForResult(analysis, resultColumns, sources[1]!.key);
    expect(ordersMapping).toEqual(["id", "user_id", undefined]);
    expect(usersMapping).toEqual([undefined, undefined, "name"]);

    // Merging per-source mappings yields the complete display mapping.
    const merged = resultColumns.map((_, index) => [ordersMapping![index], usersMapping![index]].find((value) => value !== undefined));
    expect(merged).toEqual(["id", "user_id", "name"]);
  });

  it("keeps duplicate result column names mapped in projection order", () => {
    const result = analyzeEditableQueryEditability("SELECT a.id, b.id FROM orders a JOIN users b ON a.user_id = b.id");
    expect(result.editable).toBe(true);
    if (!result.editable) return;

    const analysis = result.analysis;
    const sources = analysis.sources!;
    const merged = (["id", "id"] as string[]).map((_, index) => [sources[0]!.key, sources[1]!.key].map((key) => sourceColumnsForResult(analysis, ["id", "id"], key)?.[index]).find((value) => value !== undefined));
    expect(merged).toEqual(["id", "id"]);
  });
});
