// Regression test for t8y2/dbx #6190.
//
// Local-mode sidebar table search (sidebarTableSearchLocal, the default) only
// searches the persisted table search index. When that index has never been
// built, the first search falls back to the currently loaded first page of
// children, which silently misses alphabetically-late tables such as
// "T_Erp_Nc_SuPlan_List" (sorted after hundreds of "A_Erp_*"/"T_Bas_*" names)
// for the fuzzy query "erpncs". This test locks in the fixed behavior: the
// first search builds the index so the complete table set is searchable.
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchSidebarLabel } from "../../apps/desktop/src/lib/sidebar/sidebarSearch.ts";
import type { ConnectionConfig, TableInfo, TreeNode } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function sqlServerConnection(): ConnectionConfig {
  return {
    id: "mssql-1",
    name: "MSSQL",
    db_type: "sqlserver",
    host: "127.0.0.1",
    port: 1433,
    username: "sa",
    password: "",
    database: "erp",
  } as ConnectionConfig;
}

// A large ERP-like schema: the target table sorts after hundreds of other
// tables, so it is absent from the first unfiltered page (page size 500).
function buildTables(): TableInfo[] {
  const tables: TableInfo[] = [];
  for (let i = 0; i < 700; i++) tables.push({ name: `A_Erp_Nc_Sys_${i}`, table_type: "TABLE", comment: null });
  for (let i = 0; i < 100; i++) tables.push({ name: `T_Erp_Nc_Su_Table_${i}`, table_type: "TABLE", comment: null });
  for (let i = 0; i < 300; i++) tables.push({ name: `T_Bas_Customer_${i}`, table_type: "TABLE", comment: null });
  for (let i = 0; i < 300; i++) tables.push({ name: `T_Fin_Account_${i}`, table_type: "TABLE", comment: null });
  tables.push({ name: "T_Erp_Nc_SuPlan_List", table_type: "TABLE", comment: null });
  return tables;
}

describe("sidebar local table search first-search index build (#6190)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("builds the local search index on the first search so late-sorted tables are found", async () => {
    const allTables = buildTables();
    // Simulate the SQL Server listTables pagination contract used by
    // refreshSidebarTableSearchIndex: name-ordered pages of pageSize.
    const listTables = vi.fn(async (_conn: string, _db: string, _schema: string, _filter?: string, limit?: number, offset?: number) => {
      const sorted = [...allTables].sort((a, b) => a.name.localeCompare(b.name));
      const start = offset ?? 0;
      return sorted.slice(start, start + (limit ?? sorted.length));
    });
    const cachedPayloads = new Map<string, unknown>();
    const loadSchemaCache = vi.fn(async (key: string) => {
      const payload = cachedPayloads.get(key) ?? null;
      await Promise.resolve();
      return payload == null ? null : structuredClone(payload);
    });
    const saveSchemaCache = vi.fn(async (key: string, payload: unknown) => {
      cachedPayloads.set(key, structuredClone(payload));
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listTables,
      loadSchemaCache,
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache,
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().desktopSettings.sidebar_table_page_size = 500;

    const connection = sqlServerConnection();
    const tablesGroup: TreeNode = {
      id: "mssql-1:erp:dbo:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: connection.id,
      database: "erp",
      schema: "dbo",
      isExpanded: true,
      children: [],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        isExpanded: true,
        children: [
          {
            id: "mssql-1:erp",
            label: "erp",
            type: "database",
            connectionId: connection.id,
            database: "erp",
            isExpanded: true,
            children: [
              {
                id: "mssql-1:erp:dbo",
                label: "dbo",
                type: "schema",
                connectionId: connection.id,
                database: "erp",
                schema: "dbo",
                isExpanded: true,
                children: [tablesGroup],
              },
            ],
          },
        ],
      },
    ];

    // 1. Expand the tables group: the first page does not contain the target.
    await store.loadObjectGroupChildren(tablesGroup, { force: true });
    const firstPage = (tablesGroup.children ?? []).map((node) => node.label);
    expect(firstPage).not.toContain("T_Erp_Nc_SuPlan_List");

    // 2. Before the fix, the persisted index is missing, so the first search
    //    only sees the loaded first page and misses the target.
    expect(await store.loadSidebarTableSearchIndex(tablesGroup.id)).toBeNull();
    // Pre-fix UI path: filterLocallySearchedTables with indexed === null falls
    // back to the loaded children, so the target is invisible on first search.
    const preFixResults = firstPage.filter((name) => !!matchSidebarLabel(name, "erpncs"));
    expect(preFixResults).not.toContain("T_Erp_Nc_SuPlan_List");

    // 3. The fix: the first search builds the index (refreshSidebarTableSearchIndex
    //    pages through the complete table set), which then contains the target.
    const index = await store.refreshSidebarTableSearchIndex(tablesGroup.id);
    const indexNames = index.map((entry) => entry.name);
    expect(indexNames).toContain("T_Erp_Nc_SuPlan_List");

    // 4. The UI filter used by filterLocallySearchedTables (indexed branch)
    //    matches the target for the reported queries, on the first try.
    const erpncs = index.filter((entry) => !!matchSidebarLabel(entry.name, "erpncs"));
    expect(erpncs.map((entry) => entry.name)).toContain("T_Erp_Nc_SuPlan_List");

    const terpncs = index.filter((entry) => !!matchSidebarLabel(entry.name, "terpncs"));
    expect(terpncs.map((entry) => entry.name)).toContain("T_Erp_Nc_SuPlan_List");

    // 5. Case variants behave identically.
    for (const query of ["ERPnCS", "ERPNCS"]) {
      const matches = index.filter((entry) => !!matchSidebarLabel(entry.name, query));
      expect(matches.map((entry) => entry.name)).toContain("T_Erp_Nc_SuPlan_List");
    }

    // 6. Repeat searches are order-independent: the built index is served from
    //    the persisted cache on subsequent searches.
    const cached = await store.loadSidebarTableSearchIndex(tablesGroup.id);
    expect(cached?.map((entry) => entry.name)).toContain("T_Erp_Nc_SuPlan_List");
  }, 30000);

  it("remote search returns the complete fuzzy result set (no first-page truncation)", async () => {
    const allTables = buildTables();
    // Simulate the SQL Server backend: SQL-side fuzzy (contains OR subsequence),
    // name-ordered, with limit applied last (SELECT TOP semantics).
    const subsequence = (text: string, q: string): boolean => {
      const lower = text.toLowerCase();
      let j = 0;
      for (let i = 0; i < lower.length && j < q.length; i++) if (lower[i] === q[j]) j++;
      return j === q.length;
    };
    const listTables = vi.fn(async (_conn: string, _db: string, _schema: string, filter?: string, limit?: number, offset?: number) => {
      const q = filter?.trim().toLowerCase();
      const sorted = [...allTables].sort((a, b) => a.name.localeCompare(b.name));
      let matched = sorted;
      if (q) matched = sorted.filter((t) => t.name.toLowerCase().includes(q) || (q.length >= 2 && subsequence(t.name, q)));
      const start = offset ?? 0;
      return matched.slice(start, start + (limit ?? matched.length));
    });
    const loadSchemaCache = vi.fn().mockResolvedValue(null);
    const saveSchemaCache = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listTables,
      loadSchemaCache,
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache,
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().desktopSettings.sidebar_table_page_size = 500;

    const connection = sqlServerConnection();
    const tablesGroup: TreeNode = {
      id: "mssql-1:erp:dbo:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: connection.id,
      database: "erp",
      schema: "dbo",
      isExpanded: true,
      children: [],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        isExpanded: true,
        children: [
          {
            id: "mssql-1:erp",
            label: "erp",
            type: "database",
            connectionId: connection.id,
            database: "erp",
            isExpanded: true,
            children: [
              {
                id: "mssql-1:erp:dbo",
                label: "dbo",
                type: "schema",
                connectionId: connection.id,
                database: "erp",
                schema: "dbo",
                isExpanded: true,
                children: [tablesGroup],
              },
            ],
          },
        ],
      },
    ];

    const searchOptions = (searchFilter: string): Parameters<typeof store.loadObjectGroupChildren>[1] => ({
      force: true,
      searchFilter,
      sidebarTableSearchParentId: tablesGroup.id,
      expectedSidebarTableSearchQuery: searchFilter,
    });
    // Mirrors the real input path: the query is committed before the refresh.
    const search = async (searchFilter: string) => {
      store.setSidebarTableSearchQuery(tablesGroup.id, searchFilter);
      await store.loadObjectGroupChildren(tablesGroup, searchOptions(searchFilter));
    };

    // First remote search: the backend must receive no page limit so the fuzzy
    // result set is not truncated before the alphabetically-late target.
    await search("erpncs");
    const firstResults = (tablesGroup.children ?? []).map((node) => node.label);
    expect(firstResults).toContain("T_Erp_Nc_SuPlan_List");
    expect(listTables.mock.calls.some((call) => call[3] === "erpncs" && call[4] === undefined)).toBe(true);

    // Repeated searches are order-independent.
    await search("terpncs");
    expect((tablesGroup.children ?? []).map((node) => node.label)).toContain("T_Erp_Nc_SuPlan_List");
    await search("erpncs");
    expect((tablesGroup.children ?? []).map((node) => node.label)).toContain("T_Erp_Nc_SuPlan_List");
  }, 30000);
});
