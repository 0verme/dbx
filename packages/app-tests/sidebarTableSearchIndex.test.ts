// Unit tests for the local table search index loading helper introduced for
// t8y2/dbx #6190.
//
// Pre-fix behavior: local-mode first search only read the persisted index
// (loadSidebarTableSearchIndex). When it had never been built (null), the UI
// fell back to the currently loaded first page of children, silently missing
// alphabetically-late tables (T_Erp_Nc_SuPlan_List for "erpncs").
//
// Post-fix behavior: a missing index is built on first use so the complete
// table set is searchable immediately.
import { expect, test, vi } from "vitest";
import assert from "node:assert/strict";
import { loadOrBuildSidebarTableSearchIndex } from "../../apps/desktop/src/lib/sidebar/sidebarTableSearchIndex.ts";
import type { TableInfo } from "../../apps/desktop/src/types/database.ts";

const TARGET: TableInfo = { name: "T_Erp_Nc_SuPlan_List", table_type: "TABLE", comment: null };

test("builds the index when the persisted index is missing (first search)", async () => {
  const read = async () => null;
  const build = vi.fn(async () => [TARGET]);
  const result = await loadOrBuildSidebarTableSearchIndex(read, build);
  assert.deepEqual(result, [TARGET]);
  expect(build).toHaveBeenCalledTimes(1);
});

test("reuses the persisted index without rebuilding", async () => {
  const read = async () => [TARGET];
  const build = vi.fn(async () => []);
  const result = await loadOrBuildSidebarTableSearchIndex(read, build);
  assert.deepEqual(result, [TARGET]);
  expect(build).not.toHaveBeenCalled();
});

test("an empty persisted index (no tables) is not treated as missing", async () => {
  const read = async () => [];
  const build = vi.fn(async () => [TARGET]);
  const result = await loadOrBuildSidebarTableSearchIndex(read, build);
  assert.deepEqual(result, []);
  expect(build).not.toHaveBeenCalled();
});

test("an explicit refresh always rebuilds", async () => {
  const read = vi.fn(async () => [TARGET]);
  const build = vi.fn(async () => [{ name: "fresh", table_type: "TABLE", comment: null }]);
  const result = await loadOrBuildSidebarTableSearchIndex(read, build, true);
  assert.deepEqual(result, [{ name: "fresh", table_type: "TABLE", comment: null }]);
  expect(build).toHaveBeenCalledTimes(1);
});
