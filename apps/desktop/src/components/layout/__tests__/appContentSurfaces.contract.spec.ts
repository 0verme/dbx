import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");

// The editor-content wrapper used to carry a v-show guard that hid the whole
// workspace while the settings page or driver store was active. That guard
// also display:none-d every group tab strip, so opening a special page left
// the user with no mouse path back to the editors (v0.6.4 regression). The
// wrapper now stays visible and the workspace hides only the pane CONTENT via
// specialSurfaceActive (group tab strips remain clickable). These assertions
// pin the sibling order and the new hand-off so a future merge cannot
// re-introduce either the guard or nesting the special surfaces inside it.
describe("App main content surface structure", () => {
  it("keeps the editor workspace visible while special pages hide only its content", () => {
    const guard = 'v-show="!driverStoreActive && !settingsStore.settingsPageActive"';
    // The wrapper guard is gone; the special-page state flows into the workspace instead.
    expect(appSource).not.toContain(guard);
    expect(appSource).toContain(':special-surface-active="driverStoreActive || settingsStore.settingsPageActive"');

    // Source order: special surfaces first, then the editor wrapper.
    const markers = ["<DriverStorePage", "<EditorSettingsPage", '<div v-if="queryStore.tabs.length > 0"', "<SqlEditorWorkspace", "<WelcomeScreen"];
    const indices = markers.map((marker) => appSource.indexOf(marker));
    expect(indices.every((index) => index >= 0)).toBe(true);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  it("guards the editor wrapper with the open-tab count and chains the welcome screen to it", () => {
    expect(appSource).toContain('<div v-if="queryStore.tabs.length > 0" class="flex flex-col flex-1 min-h-0">');
    expect(appSource).toContain('v-else-if="queryStore.tabs.length === 0 && !driverStoreActive && !settingsStore.settingsPageActive"');
  });

  it("anchors the drag-back hit test on every pane strip and the special-surfaces bar", () => {
    const groupBarSource = readFileSync(new URL("../EditorGroupTabBar.vue", import.meta.url), "utf8");
    const slimBarSource = readFileSync(new URL("../AppTabBar.vue", import.meta.url), "utf8");
    expect(groupBarSource).toContain("data-main-tab-bar");
    expect(groupBarSource).toContain("'ring-2 ring-primary ring-inset': detachedDropTarget");
    expect(slimBarSource).toContain("data-main-tab-bar");
    expect(slimBarSource).toContain("'ring-2 ring-primary ring-inset': detachedDropTarget");
    // The split workspace renders several bars; the hit test must union their rects.
    expect(appSource).toContain('querySelectorAll<HTMLElement>("[data-main-tab-bar]")');
  });
});
