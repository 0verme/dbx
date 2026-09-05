import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const appPath = "apps/desktop/src/App.vue";
const workspacePath = "apps/desktop/src/components/layout/SqlEditorWorkspace.vue";

// App.vue 是根组件无法挂载；打开设置/驱动管理后“整个工作区被 v-show 藏掉、
// 标签页凭空消失”正是 App 层接线回归（v0.6.3 分栏重构），这里钉住接线形态。
test("opening a special page keeps the workspace mounted with visible group tab strips", () => {
  const appSource = readFileSync(appPath, "utf8");

  // 工作区不再整体隐藏；改为把「特殊页激活」下传，由分组只隐藏内容列、保留标签条。
  assert.match(appSource, /:special-surface-active="driverStoreActive \|\| settingsStore\.settingsPageActive"/);
  assert.doesNotMatch(appSource, /v-show="!driverStoreActive && !settingsStore\.settingsPageActive"/);
});

test("the workspace collapses the shared result pane and hides group content while a special page is active", () => {
  const workspaceSource = readFileSync(workspacePath, "utf8");

  assert.match(workspaceSource, /specialSurfaceActive\?: boolean/);
  assert.match(workspaceSource, /showSharedResult\.value && showResultPane\.value && !props\.specialSurfaceActive \? resultPaneSize\.value : 0/);
  assert.match(workspaceSource, /:content-hidden="specialSurfaceActive"/);
});
