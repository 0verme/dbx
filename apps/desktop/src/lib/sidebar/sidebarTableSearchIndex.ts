import type { TableInfo } from "@/types/database";

/**
 * Load the local table search index for a sidebar scope, building it on first
 * use.
 *
 * A missing persisted index (read returns null) means the scope was never
 * indexed, so only the currently loaded first page of children would be
 * searchable. That silently misses alphabetically-late tables — e.g.
 * "T_Erp_Nc_SuPlan_List" for the fuzzy query "erpncs" — until an explicit
 * index refresh happens (the refresh button). Building the index on the first
 * search makes the complete table set searchable from the start, matching the
 * behavior of an explicit refresh.
 */
export async function loadOrBuildSidebarTableSearchIndex(read: () => Promise<TableInfo[] | null>, build: () => Promise<TableInfo[]>, refresh = false): Promise<TableInfo[] | null> {
  if (refresh) return build();
  return (await read()) ?? build();
}
