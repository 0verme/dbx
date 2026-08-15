import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMulti = vi.fn();
const executeQuery = vi.fn();
const analyzeEditableQueryEditability = vi.fn();
const getColumns = vi.fn();
const listIndexes = vi.fn();
const listObjects = vi.fn();
const getConnectionConfig = vi.fn();
const lookupLocalCompletionTables = vi.fn();
const buildSortedQuerySql = vi.fn();
const buildDataGridCountSql = vi.fn();
const prepareQueryPaginationExecutionPlan = vi.fn(async (options) => ({
  sqlToExecute: options.sql,
  pageSql: undefined,
  pageLimit: undefined,
  pageOffset: undefined,
  countSql: undefined,
  useAgentResultSession: false,
}));
const editorSettings = {
  pageSize: 100,
  autoCalculateTotalRows: false,
};

vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability,
  buildDataGridCountSql,
  buildSortedQuerySql,
  closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
  closeQuerySession: vi.fn().mockResolvedValue(undefined),
  executeMulti,
  executeQuery,
  getColumns,
  listIndexes,
  listObjects,
  prepareQueryPaginationExecutionPlan,
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: getConnectionConfig,
    lookupLocalCompletionTables,
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings,
  }),
}));

function column(name: string, comment: string | null, isPrimaryKey = false) {
  return { name, data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: isPrimaryKey, extra: null, comment };
}

const ordersColumns = [column("id", "订单ID", true), column("user_id", "下单用户"), column("amount", "订单金额")];
const usersColumns = [column("id", "用户ID", true), column("name", "用户名")];

/** SELECT a.id, a.user_id, b.id, b.name FROM orders a JOIN users b ON a.user_id = b.id */
const joinAnalysis = {
  editable: true,
  analysis: {
    schema: undefined,
    tableName: "orders",
    tableAlias: "a",
    selectStar: false,
    columns: [
      { sourceName: "id", sourceKey: "a", resultName: "id", expression: "a.id" },
      { sourceName: "user_id", sourceKey: "a", resultName: "user_id", expression: "a.user_id" },
      { sourceName: "id", sourceKey: "b", resultName: "id_1", expression: "b.id" },
      { sourceName: "name", sourceKey: "b", resultName: "name", expression: "b.name" },
    ],
    sources: [
      { key: "a", tableName: "orders", alias: "a" },
      { key: "b", tableName: "users", alias: "b" },
    ],
    multiSource: true,
    allowInsertDelete: false,
  },
};

describe("queryStore multi-source result column comments", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { clearTableMetadataCache } = await import("@/lib/metadata/tableMetadataCache");
    clearTableMetadataCache();
    setActivePinia(createPinia());
    getConnectionConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app", query_timeout_secs: 30 });
    getColumns.mockImplementation(async (_connectionId: string, _database: string, _schema: string, table: string) => (table === "orders" ? ordersColumns : usersColumns));
    listIndexes.mockResolvedValue([]);
    listObjects.mockResolvedValue([]);
    lookupLocalCompletionTables.mockReturnValue([]);
    analyzeEditableQueryEditability.mockResolvedValue(joinAnalysis);
    buildSortedQuerySql.mockResolvedValue({ ok: true, sql: `${"SELECT *"} ORDER BY 1` });
    buildDataGridCountSql.mockResolvedValue("SELECT COUNT(*) FROM `orders`");
    executeQuery.mockResolvedValue({
      columns: ["row_count"],
      rows: [[0]],
      affected_rows: 0,
      execution_time_ms: 1,
    });
    executeMulti.mockResolvedValue([
      {
        columns: ["id", "user_id", "id_1", "name"],
        rows: [[1, 100, 7, "Alice"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);
  });

  afterEach(() => {
    expect(listObjects).not.toHaveBeenCalled();
  });

  it("merges column comments from every JOIN source table onto the non-editable result", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT a.id, a.user_id, b.id, b.name FROM orders a JOIN users b ON a.user_id = b.id");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.resultColumnComments).toBeDefined());

    // Multi-source results stay non-editable: no single tableMeta.
    expect(tab.tableMeta).toBeUndefined();
    expect(tab.queryEditabilityReason).toBe("complex-source");
    expect(tab.querySourceColumns).toBeUndefined();

    // Comments from both sources are merged; the first source wins on name clashes.
    expect(tab.resultColumnComments).toEqual({
      id: "订单ID",
      user_id: "下单用户",
      amount: "订单金额",
      name: "用户名",
    });

    // Display-only mapping resolves each result column back to its source column.
    expect(tab.queryDisplaySourceColumns).toEqual(["id", "user_id", "id", "name"]);
  });

  it("keeps single-source results free of multi-source comment fields", async () => {
    analyzeEditableQueryEditability.mockResolvedValue({
      editable: true,
      analysis: {
        schema: undefined,
        tableName: "orders",
        selectStar: false,
        columns: [
          { sourceName: "id", sourceKey: "orders:0", resultName: "id", expression: "id" },
          { sourceName: "amount", sourceKey: "orders:0", resultName: "amount", expression: "amount" },
        ],
      },
    });
    getColumns.mockResolvedValue(ordersColumns);
    executeMulti.mockResolvedValue([
      {
        columns: ["id", "amount"],
        rows: [[1, 9.99]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");

    await store.executeTabSql(tabId, "SELECT id, amount FROM orders");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    await vi.waitFor(() => expect(tab.tableMeta?.tableName).toBe("orders"));
    expect(tab.resultColumnComments).toBeUndefined();
    expect(tab.queryDisplaySourceColumns).toBeUndefined();
    expect(tab.querySourceColumns).toEqual(["id", "amount"]);
  });
});
