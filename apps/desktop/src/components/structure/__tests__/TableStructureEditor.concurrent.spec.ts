import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../TableStructureEditor.vue", import.meta.url), "utf8");

describe("TableStructureEditor concurrent index (Plan A scope guards)", () => {
  it("disables the Concurrent checkbox for existing indexes and partitioned parents", () => {
    expect(source).toContain(':disabled="!canEditIndexConcurrent(index)"');
    expect(source).toContain("function canEditIndexConcurrent(index: EditableStructureIndex): boolean");
    expect(source).toContain("if (index.original) return false;");
    expect(source).toContain("if (isPartitionedParent.value) return false;");
  });

  it("explains why the checkbox is disabled via the cell tooltip", () => {
    expect(source).toContain("function concurrentIndexCellTitle(index: EditableStructureIndex): string");
    expect(source).toContain('t("structureEditor.concurrentExistingIndexTooltip")');
    expect(source).toContain('t("structureEditor.concurrentPartitionedTooltip")');
  });

  it("passes the partitioned flag into the SQL builder options", () => {
    expect(source).toContain("partitioned: isPartitionedParent.value,");
  });

  it("routes concurrent saves through a dedicated long timeout", () => {
    expect(source).toContain('import { CONCURRENT_INDEX_QUERY_TIMEOUT_SECS, queryTimeoutSecsForConnection } from "@/lib/sql/queryTimeout";');
    expect(source).toContain('const hasConcurrentIndexBuild = pendingStatements.value.some((statement) => statement.includes("CONCURRENTLY"));');
    expect(source).toContain("? CONCURRENT_INDEX_QUERY_TIMEOUT_SECS");
  });

  it("blocks a save when a same-name INVALID index would doom a concurrent build", () => {
    expect(source).toContain("const invalidIndexes = await api.listInvalidIndexes(props.connectionId, props.database, metadataSchema.value, props.tableName);");
    expect(source).toContain('t("structureEditor.invalidIndexBlocksSave", { indexNames: blocked.join(", ") })');
  });

  it("surfaces INVALID leftovers on failure instead of failing silently", () => {
    expect(source).toContain("hasConcurrentIndexBuild && /already exists/i.test(rawMessage)");
    expect(source).toContain('t("structureEditor.invalidIndexRetryHint")');
  });
});
