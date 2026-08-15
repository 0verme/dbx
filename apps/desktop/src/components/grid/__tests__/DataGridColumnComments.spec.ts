import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid column comments", () => {
  it("uses source column metadata for both inline and tooltip header comments", () => {
    expect(dataGridSource).toMatch(/function resolvedColumnComment\(column: string, actualColIdx: number\)[\s\S]*?props\.sourceColumns\?\.\[actualColIdx\][\s\S]*?\);/);
    expect(dataGridSource).toContain(':column-comment="headerColumnComment(col.name, col.actualColIdx)"');
    expect(dataGridSource).toContain(':tooltip-column-comment="resolvedColumnComment(col.name, col.actualColIdx)"');
    expect(dataGridSource).toContain("(column, index) => headerColumnComment(column, index)");
  });

  it("merges multi-source result column comments into the header comment map", () => {
    expect(dataGridSource).toMatch(/const columnCommentMap = computed\(\(\) => \{[\s\S]*?props\.tableMeta\?\.columns[\s\S]*?props\.resultColumnComments[\s\S]*?return map;\s*\}\);/);
    expect(dataGridSource).toContain("resultColumnComments?: Record<string, string>");
  });

  it("prefers the display-only source mapping when resolving multi-source comments", () => {
    expect(dataGridSource).toMatch(/function resolvedColumnComment\(column: string, actualColIdx: number\)[\s\S]*?props\.queryDisplaySourceColumns\?\.\[actualColIdx\][\s\S]*?dataGridColumnCommentFor\([\s\S]*?\);/);
    expect(dataGridSource).toContain("queryDisplaySourceColumns?: Array<string | undefined>");
  });
});
