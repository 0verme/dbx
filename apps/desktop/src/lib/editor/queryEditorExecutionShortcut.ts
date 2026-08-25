import type { Command, EditorView, KeyBinding } from "@codemirror/view";
import { shortcutToCodeMirrorKey } from "@/lib/editor/shortcutRegistry";

/**
 * Create a query-editor execution binding that consumes the shortcut while an
 * IME composition is active, without invoking the execution callback.
 *
 * CodeMirror may ignore keydown events after a composition has changed the
 * document, so the app-level shortcut fallback also checks the editor state.
 * This guard covers the keymap path when CodeMirror still dispatches it.
 */
export function createQueryEditorExecutionShortcutBindings(shortcut: string, run: Command, isComposing: (view: EditorView) => boolean): KeyBinding[] {
  if (!shortcut) return [];
  return [
    {
      key: shortcutToCodeMirrorKey(shortcut),
      preventDefault: true,
      run(view) {
        if (isComposing(view)) return true;
        return run(view);
      },
    },
  ];
}
