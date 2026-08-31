// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import TreeItem from "@/components/sidebar/TreeItem.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { ConnectionConfig, SidebarLayout, TreeNode } from "@/types/database";

const connectionId = "connection-1";

function connectionConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: connectionId,
    name: "Test connection",
    db_type: "oracle",
    host: "127.0.0.1",
    port: 1521,
    username: "SCOTT",
    password: "",
    ...overrides,
  } as ConnectionConfig;
}

const state = {
  config: connectionConfig(),
};

const connectionStore = {
  activeConnectionId: connectionId,
  connectedIds: new Set([connectionId]),
  connectingIds: new Set<string>(),
  connectionErrors: {},
  connectionMultiSelectActive: false,
  connections: [] as { id: string }[],
  getConfig: () => state.config,
  getSidebarVisibleFilterSummary: () => null,
  clearConnectionError: vi.fn(),
  isDefaultDatabase: () => false,
  isDefaultSchema: () => false,
  isPinnedTreeNodeReorderTarget: () => false,
  isTreeNodeChildrenLoaded: () => false,
  isTreeNodePinned: () => false,
  selectedTreeNodeId: null as string | null,
  selectedTreeNodeIds: [] as string[],
  selectedTreeNodeIdsSet: new Set<string>(),
  sidebarLayout: { groups: [], order: [] } as SidebarLayout,
  sidebarTableSearchQueries: {},
  tableNameFilterForScope: () => undefined,
  treeNodes: [] as TreeNode[],
  treeSelectionAnchorId: null as string | null,
};

const settingsStore = {
  editorSettings: {
    shortcuts: { openDataInNewTab: "" },
    sidebarActivation: "double" as const,
    sidebarAllowHorizontalScroll: false,
    sidebarHiddenTablePrefixes: [],
    sidebarObjectInfoMode: "none",
  },
};

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => connectionStore,
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({ openDatabaseKeys: new Set<string>() }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => settingsStore,
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/components/icons/DatabaseIcon.vue", () => ({ default: { template: "<span />" } }));
vi.mock("@/components/connection/ConnectionErrorIndicator.vue", () => ({ default: { template: "<span />" } }));
vi.mock("@/components/common/ProductionContextBadge.vue", () => ({ default: { template: "<span />" } }));
vi.mock("@/components/ui/badge", () => ({ Badge: { template: "<span><slot /></span>" } }));
vi.mock("@/components/ui/input", () => ({ Input: { template: "<input />" } }));
vi.mock("@/components/ui/switch", () => ({ Switch: { template: "<input />" } }));
vi.mock("@/components/ui/LightTooltip.vue", () => ({ default: { template: "<span><slot /></span>" } }));

const mountedApps: App[] = [];

function runtimeHost(): SidebarTreeRuntimeHost {
  return {
    buildContextMenu: vi.fn(() => []),
    handleRowClick: vi.fn(),
    handleRowDoubleClick: vi.fn(),
    handleRowKeydown: vi.fn(),
    openPrimaryVisibleFilter: vi.fn(),
    openDataInNewTab: vi.fn(),
    requestPaste: vi.fn(() => false),
    toggleNode: vi.fn(),
  };
}

function connectionNode(): TreeNode {
  return {
    id: connectionId,
    label: "Test connection",
    type: "connection",
    connectionId,
    children: [],
  };
}

function schemaNode(schema: string): TreeNode {
  return {
    id: `${connectionId}:${schema}`,
    label: schema,
    type: "schema",
    connectionId,
    database: "ORCL",
    schema,
    children: [],
  };
}

async function mountTreeItem(node: TreeNode, config: ConnectionConfig) {
  state.config = config;
  const container = document.createElement("div");
  document.body.append(container);
  const runtime = createSidebarTreeRuntime();
  runtime.bindHost(runtimeHost());
  const app = createApp(
    defineComponent({
      setup: () => () => h(TreeItem, { node, depth: 2 }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, runtime);
  app.mount(container);
  await nextTick();

  const label = [...container.querySelectorAll<HTMLElement>("span")].find((element) => element.textContent === node.label && element.children.length === 0);
  if (!label) throw new Error(`Tree item label was not rendered: ${container.innerHTML}`);
  return label;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
  state.config = connectionConfig();
  connectionStore.selectedTreeNodeId = null;
  connectionStore.selectedTreeNodeIds = [];
  connectionStore.selectedTreeNodeIdsSet = new Set<string>();
});

describe("TreeItem login user highlight", () => {
  it("does not bold an ordinary connection row", async () => {
    const label = await mountTreeItem(connectionNode(), connectionConfig({ db_type: "oracle", username: "SCOTT" }));

    expect(label.classList).not.toContain("font-semibold");
  });

  it.each([
    ["PostgreSQL", "postgres" as const],
    ["MySQL", "mysql" as const],
  ])("does not bold a matching schema name for %s", async (_name, dbType) => {
    const schema = "app_user";
    const label = await mountTreeItem(schemaNode(schema), connectionConfig({ db_type: dbType, username: schema }));

    expect(label.classList).not.toContain("font-semibold");
  });

  it.each([
    ["Oracle", "oracle" as const, "SCOTT", "scott"],
    ["Dameng", "dameng" as const, "TEST01", "test01"],
    ["OceanBase Oracle mode", "oceanbase-oracle" as const, "APP", "app"],
  ])("bolds the current login-user schema for %s", async (_name, dbType, schema, username) => {
    const label = await mountTreeItem(schemaNode(schema), connectionConfig({ db_type: dbType, username }));

    expect(label.classList).toContain("font-semibold");
  });

  it("does not bold another Oracle-family schema", async () => {
    const label = await mountTreeItem(schemaNode("HR"), connectionConfig({ db_type: "oracle", username: "SCOTT" }));

    expect(label.classList).not.toContain("font-semibold");
  });
});
