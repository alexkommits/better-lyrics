/**
 * The settings page (M5). Static markup in settings.html carries __MSG_*__ placeholders; this
 * module wires live-apply. Everything persists through the same storage adapters the player uses,
 * and changes propagate to an open player through the storage BroadcastChannel — no page reload
 * needed except for the interface language (which reloads this page for the new locale).
 */

import { initI18n } from "@core/i18n";
import { getLocalStorage, getSyncStorage, setLocalStorage, setSyncStorage } from "@core/storage";
import { applyStoredThemeSettings } from "@core/themeSettingsBridge";
import { applyLoggingSetting } from "@modules/settings/loggingSetting";
import { logCore, warnCore } from "@core/logger";

const THEME_FILES: Record<string, string> = {
  default: "Default.css",
  hdr: "HDR.css",
};

/** Keep in sync with `ls _locales` — the UI language picker offers exactly these. */
const UI_LANGUAGES = [
  "cs", "de", "en", "es", "fil", "fr", "hu", "id", "it", "ja", "ko", "nl", "pl",
  "pt_BR", "pt_PT", "ro", "ru", "th", "tr", "uk", "uz", "vi", "zh_CN", "zh_TW",
] as const;

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} in settings.html`);
  return element as T;
}

function languageDisplayName(code: string): string {
  try {
    return new Intl.DisplayNames([navigator.language], { type: "language" }).of(code.replace("_", "-")) ?? code;
  } catch {
    return code;
  }
}

async function applyTheme(theme: string): Promise<void> {
  const file = THEME_FILES[theme] ?? THEME_FILES.default;
  try {
    const response = await fetch(`/css/themes/${file}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // The player re-applies customCSS over the storage BroadcastChannel.
    const rics = await response.text();
    await setLocalStorage({ customCSS: rics, cssCompressed: false, uiTheme: THEME_FILES[theme] ? theme : "default" });
  } catch (error) {
    warnCore("Failed to apply the theme:", error);
  }
}

async function boot(): Promise<void> {
  await initI18n();
  applyStoredThemeSettings();

  const [syncItems, localItems] = await Promise.all([
    getSyncStorage<{ uiLanguage?: string; isLogsEnabled?: boolean }>({ uiLanguage: "auto", isLogsEnabled: true }),
    getLocalStorage<{
      customCSS?: string;
      uiTheme?: string;
      "blyrics-sync-granularity"?: string;
      "blyrics-hide-instrumental-only"?: boolean;
      "blyrics-resolve-youtube-ids"?: boolean;
      "blyrics-youtube-data-api-key"?: string;
    }>([
      "uiTheme",
      "blyrics-sync-granularity",
      "blyrics-hide-instrumental-only",
      "blyrics-resolve-youtube-ids",
      "blyrics-youtube-data-api-key",
    ]),
  ]);

  // -- Theme
  const themeSelect = mustGet<HTMLSelectElement>("setting-theme");
  themeSelect.value = localItems.uiTheme && THEME_FILES[localItems.uiTheme] ? localItems.uiTheme : "default";
  themeSelect.addEventListener("change", () => void applyTheme(themeSelect.value));

  // -- Language
  const languageSelect = mustGet<HTMLSelectElement>("setting-language");
  const autoOption = document.createElement("option");
  autoOption.value = "auto";
  autoOption.textContent = languageSelect.dataset.autoLabel ?? "Automatic";
  languageSelect.appendChild(autoOption);
  for (const code of UI_LANGUAGES) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = languageDisplayName(code);
    languageSelect.appendChild(option);
  }
  languageSelect.value = syncItems.uiLanguage ?? "auto";
  languageSelect.addEventListener("change", () => {
    void setSyncStorage({ uiLanguage: languageSelect.value }).then(() => window.setTimeout(() => window.location.reload(), 150));
  });

  // -- Granularity
  const granularitySelect = mustGet<HTMLSelectElement>("setting-granularity");
  granularitySelect.value = localItems["blyrics-sync-granularity"] ?? "auto";
  granularitySelect.addEventListener("change", () => {
    void setLocalStorage({ "blyrics-sync-granularity": granularitySelect.value });
  });

  // -- Toggles
  const hideInstrumental = mustGet<HTMLInputElement>("setting-hide-instrumental");
  hideInstrumental.checked = localItems["blyrics-hide-instrumental-only"] === true;
  hideInstrumental.addEventListener("change", () => {
    void setLocalStorage({ "blyrics-hide-instrumental-only": hideInstrumental.checked });
  });

  const resolveIds = mustGet<HTMLInputElement>("setting-resolve-youtube-ids");
  resolveIds.checked = localItems["blyrics-resolve-youtube-ids"] !== false;
  resolveIds.addEventListener("change", () => {
    void setLocalStorage({ "blyrics-resolve-youtube-ids": resolveIds.checked });
  });

  const logging = mustGet<HTMLInputElement>("setting-logging");
  logging.checked = syncItems.isLogsEnabled !== false;
  logging.addEventListener("change", () => {
    void setSyncStorage({ isLogsEnabled: logging.checked }).then(() => applyLoggingSetting());
  });

  // -- YouTube Data API key (M5: field ships here; the resolver already honours it)
  const dataApiKey = mustGet<HTMLInputElement>("setting-data-api-key");
  dataApiKey.value = localItems["blyrics-youtube-data-api-key"] ?? "";
  let keyTimer: number | undefined;
  dataApiKey.addEventListener("input", () => {
    window.clearTimeout(keyTimer);
    keyTimer = window.setTimeout(() => {
      void setLocalStorage({ "blyrics-youtube-data-api-key": dataApiKey.value.trim() });
    }, 400);
  });

  logCore("Settings page ready");
}

document.addEventListener("DOMContentLoaded", () => {
  boot().catch(error => warnCore("Settings page failed to initialise:", error));
});
