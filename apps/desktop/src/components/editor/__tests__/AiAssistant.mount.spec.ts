// @vitest-environment happy-dom
//
// Mounted smoke test for the AI panel. The app loads the AI config at startup,
// so the panel normally mounts with `isAiConfigLoaded` already true and its
// `immediate` default-selection watcher runs during setup. That path once read
// `boundConnection` before it was declared, and the TDZ ReferenceError kept the
// panel from opening at all.
import { createApp, h } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import AiAssistant from "@/components/editor/AiAssistant.vue";
import { useSettingsStore } from "@/stores/settingsStore";

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const empty = () => Promise.resolve([]);
  return {
    ...actual,
    loadAiConversations: empty,
    loadAiRuns: empty,
    readUserSkills: empty,
    loadAiConfigs: empty,
    loadPromptTemplates: empty,
    getAiGlobalCustomInstructions: () => Promise.resolve(""),
    saveAiChatSelection: () => Promise.resolve(),
    loadAiChatSelection: () => Promise.resolve(null),
  };
});

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

async function mountPanel(aiConfigLoaded: boolean): Promise<unknown[]> {
  const pinia = createPinia();
  const errors: unknown[] = [];
  const app = createApp({ render: () => h(TooltipProvider, () => h(AiAssistant)) });
  app.use(pinia);
  app.use(i18n);
  app.config.errorHandler = (error) => errors.push(error);
  app.config.warnHandler = () => {};
  useSettingsStore(pinia).isAiConfigLoaded = aiConfigLoaded;
  const container = document.createElement("div");
  document.body.append(container);
  app.mount(container);
  cleanups.push(() => {
    app.unmount();
    container.remove();
  });
  // Let mount-time loads settle so their failures surface here too.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return errors;
}

describe("AiAssistant mount", () => {
  it("opens when the AI config was loaded before the panel mounted", async () => {
    expect((await mountPanel(true)).map(String)).toEqual([]);
  });

  it("opens while the AI config is still loading", async () => {
    expect((await mountPanel(false)).map(String)).toEqual([]);
  });
});
