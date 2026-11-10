import { decompressString, isCompressed } from "@core/compression";
import { buildStoreThemeContent, saveCustomCss } from "@core/customCss";
import {
  getAppliedStoreThemeId,
  getLocalStorage,
  getSyncStorage,
  setSyncStorage,
  subscribeStorageChanges,
} from "@core/storage";
import { setActiveStoreTheme } from "@/options/store/themeStoreManager";
import type { InstalledStoreTheme } from "@/options/store/types";
import { editorStateManager } from "../core/state";
import { ricsCompiler } from "./compiler";
import { setThemeName, showThemeName, themeSourceToEditorSource } from "./themes";
import { t } from "@core/i18n";
import { errorEditor, logEditor, warnEditor } from "@core/logger";
import { toast } from "@/ui/toast";

interface CSSStorageData {
  customCSS?: string | null;
  cssCompressed?: boolean;
}

// customCss.ts now stores the editor's CSS under a single `customCSS` key in local storage
// (compressed when large); the sync/chunked strategies were chrome.storage.sync quota workarounds.
async function loadCustomCSS(): Promise<string> {
  try {
    const localData = await getLocalStorage<CSSStorageData>(["customCSS", "cssCompressed"]);
    const css = localData.customCSS ?? null;
    const compressed = localData.cssCompressed || false;

    if (!css) return "";
    if (compressed || isCompressed(css)) {
      return decompressString(css);
    }
    return css;
  } catch (error) {
    console.error("Error loading CSS:", error);
    return "";
  }
}

const SAVE_TOAST_ID = "editor-save";
let saveToastOpen = false;
let latestSave = 0;

export function showSyncSaving(): number {
  latestSave++;
  if (!saveToastOpen) {
    saveToastOpen = true;
    toast.loading(t("options_editor_saving"), { id: SAVE_TOAST_ID });
  }
  return latestSave;
}

export function showSyncSuccess(save: number): void {
  if (!saveToastOpen || save !== latestSave) return;
  saveToastOpen = false;
  toast.success(t("options_nickname_status_saved"), { id: SAVE_TOAST_ID });
}

export function cancelSyncSaving(save: number): void {
  if (!saveToastOpen || save !== latestSave) return;
  saveToastOpen = false;
  toast.dismiss(SAVE_TOAST_ID);
}

export function showSyncError(error: unknown, save: number): void {
  if (save !== latestSave) return;
  saveToastOpen = false;
  const message = error instanceof Error ? error.message : "";
  const storageFull = message.includes("quota") || message.includes("QUOTA_BYTES");
  toast.error(t(storageFull ? "editor_alert_storageFull" : "editor_alert_saveFailed"), { id: SAVE_TOAST_ID });
}

export async function broadcastRICSToTabs(ricsSource: string, strategy: "local" | "sync" | "chunked"): Promise<void> {
  logEditor(`Broadcasting RICS to tabs, source length: ${ricsSource.length}, strategy: ${strategy}`);

  if (!ricsCompiler.isValidRics(ricsSource)) {
    const state = ricsCompiler.getLastCompilationState();
    warnEditor("RICS validation failed, broadcasting anyway:", state?.errors);
  }

  try {
    // Same-origin MPA: the player listens on this channel (see settings/settings.ts).
    const channel = new BroadcastChannel("blyrics-settings");
    channel.postMessage({ action: "applyStyles", ricsSource });
    channel.close();
    logEditor("applyStyles broadcast sent");
  } catch (err) {
    logEditor("broadcastRICSToTabs exception:", err);
  }
}

interface ApplyStoreThemeOptions {
  themeId: string;
  css: string;
  title: string;
  creators: string[];
  source?: "marketplace" | "url";
}

export async function applyStoreThemeComplete(options: ApplyStoreThemeOptions): Promise<boolean> {
  const { themeId, css, title, creators, source } = options;
  const themeContent = buildStoreThemeContent(title, creators, css);

  try {
    editorStateManager.incrementSaveCount();

    await setSyncStorage({ themeName: `store:${themeId}` });
    await setActiveStoreTheme(themeId);

    const saveResult = await saveCustomCss(themeContent);
    if (!saveResult.success) {
      throw new Error("Failed to save theme to storage");
    }

    const event = new CustomEvent("store-theme-applied", {
      detail: { themeId, css: themeContent, title, source },
    });
    document.dispatchEvent(event);

    await broadcastRICSToTabs(themeContent, saveResult.strategy || "sync");

    return true;
  } catch (err) {
    errorEditor("Failed to apply store theme:", err);
    return false;
  }
}

class StorageManager {
  private isInitialized = false;

  initialize(): void {
    if (this.isInitialized) {
      warnEditor("StorageManager already initialized");
      return;
    }

    logEditor("Initializing storage listeners");

    subscribeStorageChanges(async (changes, namespace) => {
      logEditor(`Storage changed in ${namespace}:`, Object.keys(changes));

      if (Object.hasOwn(changes, "customCSS")) {
        await this.handleCSSChange(changes.customCSS);
      }

      if (Object.hasOwn(changes, "themeName")) {
        await this.handleThemeNameChange();
      }

      if (namespace === "local") {
        for (const key of Object.keys(changes)) {
          if (key.startsWith("storeTheme:")) {
            const themeId = key.replace("storeTheme:", "");
            await this.handleIndividualThemeUpdate(
              themeId,
              changes[key] as { oldValue?: InstalledStoreTheme; newValue?: InstalledStoreTheme }
            );
          }
        }
      }
    });

    this.isInitialized = true;
    logEditor("Storage listeners initialized");
  }

  private async handleCSSChange(_change: any): Promise<void> {
    if (editorStateManager.getIsSaving()) {
      logEditor("Skipping CSS reload (save in progress)");
      return;
    }

    if (editorStateManager.getIsUserTyping()) {
      logEditor("Skipping CSS reload (user is typing)");
      return;
    }

    const saveCount = editorStateManager.getSaveCount();
    logEditor(`CSS change detected, saveCount: ${saveCount}`);

    if (saveCount > 0) {
      logEditor("Skipping CSS reload (saveCount > 0)");
      editorStateManager.decrementSaveCount();
      return;
    }

    logEditor("Loading CSS from storage");

    await editorStateManager.queueOperation("storage", async () => {
      const css = await loadCustomCSS();
      logEditor(`CSS loaded from storage: ${css.length} bytes`);

      await editorStateManager.setEditorContent(css, "storage-change");
    });
  }

  private async handleThemeNameChange(): Promise<void> {
    if (editorStateManager.getIsSaving()) {
      logEditor("Skipping theme reload (save in progress)");
      return;
    }

    if (editorStateManager.getIsUserTyping()) {
      logEditor("Skipping theme reload (user is typing)");
      await setThemeName();
      return;
    }

    logEditor("Theme name changed, reloading CSS");
    await setThemeName();

    await editorStateManager.queueOperation("storage", async () => {
      const css = await loadCustomCSS();
      logEditor(`CSS loaded from theme change: ${css.length} bytes`);
      await editorStateManager.setEditorContent(css, "theme-name-change", false);
    });
  }

  private async handleIndividualThemeUpdate(
    themeId: string,
    change: { oldValue?: InstalledStoreTheme; newValue?: InstalledStoreTheme }
  ): Promise<void> {
    if (editorStateManager.getIsSaving()) {
      logEditor("Skipping store theme reload (save in progress)");
      return;
    }

    if (editorStateManager.getIsUserTyping()) {
      logEditor("Skipping store theme reload (user is typing)");
      return;
    }

    if ((await getAppliedStoreThemeId()) !== themeId) return;

    const newTheme = change.newValue;
    if (!newTheme?.css || !newTheme?.title) return;

    if (change.oldValue?.version === newTheme.version && change.oldValue?.css === newTheme.css) {
      logEditor("Store theme unchanged, skipping");
      return;
    }

    const themeVersion = newTheme.version || "unknown";

    logEditor(`Store theme updated: ${newTheme.title} v${themeVersion}`);

    const themeContent = buildStoreThemeContent(newTheme.title, newTheme.creators, newTheme.css);
    const displayName = newTheme.version ? `${newTheme.title} (v${newTheme.version})` : newTheme.title;

    await editorStateManager.queueOperation("storage", async () => {
      await editorStateManager.setEditorContent(themeContent, "store-theme-update", false);

      editorStateManager.setCurrentThemeName(newTheme.title);
      const editorSource = themeSourceToEditorSource(newTheme.source);
      showThemeName(displayName, editorSource);

      const result = await saveCustomCss(themeContent);
      if (result.success && result.strategy) {
        await broadcastRICSToTabs(themeContent, result.strategy);
        logEditor("Store theme update synced to customCSS");
      }
    });
  }

  async loadInitialCSS(): Promise<void> {
    logEditor("Loading initial CSS");

    await editorStateManager.queueOperation("init", async () => {
      const css = await loadCustomCSS();
      logEditor(`Initial CSS loaded: ${css.length} bytes`);

      await editorStateManager.setEditorContent(css, "initial-load", false);
    });
  }
}

export const storageManager = new StorageManager();
