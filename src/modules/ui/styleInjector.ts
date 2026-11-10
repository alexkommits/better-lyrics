import { reloadLyrics } from "@core/appState";
import { decompressString, isCompressed } from "@core/compression";
import {
  compileRicsToStyles,
  getAppliedStoreThemeId,
  getLocalStorage,
  getSyncStorage,
  subscribeStorageChanges,
} from "@core/storage";
import { applyKaraokeTheme } from "@modules/karaoke/karaokeView";
import { mainView } from "./mainLyricsView";
import { publishSecondaryViews } from "@modules/ui/secondaryViews";
import { logCore, logError } from "@core/logger";
import { migrateLetterWavePref, type LetterWavePref } from "@modules/settings/letterWave";

let hasSubscribedToStyles = false;
let letterWavePref: LetterWavePref = "auto";

// Position decides precedence: parseThemeConfig is last-wins. "auto" sits before
// the theme so the theme can override it (today's behaviour); "on"/"off" sit
// after, so the user's choice is the last word.
function withLetterWaveSetting(css: string): string {
  switch (letterWavePref) {
    case "on":
      return `${css}\n/* blyrics-letter-wave = true; */`;
    case "off":
      return `${css}\n/* blyrics-letter-wave = false; */`;
    default:
      return `/* blyrics-letter-wave = false; */\n${css}`;
  }
}

/**
 * Hands a compiled theme to the side panel's view, which parses the `blyrics-*` config out of it,
 * applies the stylesheet to this document and reports whether the lines have to be built again.
 * Everything before this point is the extension's: where the theme was stored, whether it was
 * compressed, and compiling the RICS source it is written in.
 */
export function applyCustomStyles(css: string): void {
  const themeCss = withLetterWaveSetting(css);
  const needsLyricReload = mainView.setTheme(themeCss);
  applyKaraokeTheme(themeCss);
  publishSecondaryViews();

  if (needsLyricReload) {
    reloadLyrics();
  }
}

function decompressStyles(css: string): string {
  return decompressString(css);
}

export async function getAndApplyCustomStyles(): Promise<void> {
  const raw = await getSyncStorage<{ letterWavePref?: string; isLetterWaveEnabled?: boolean }>([
    "letterWavePref",
    "isLetterWaveEnabled",
  ]);
  letterWavePref = migrateLetterWavePref(raw);

  try {
    const localData = await getLocalStorage<{ customCSS?: string; cssCompressed?: boolean }>([
      "customCSS",
      "cssCompressed",
    ]);

    let css = localData.customCSS ?? null;
    if (css) {
      if (localData.cssCompressed || isCompressed(css)) {
        css = decompressStyles(css);
      }
      applyCustomStyles(compileRicsToStyles(css));
    } else {
      applyCustomStyles("");
    }
  } catch (error) {
    logError(error);
  }
}

async function handleStoreThemeChange(key: string, change: { oldValue?: any; newValue?: any }): Promise<void> {
  const themeId = key.replace("storeTheme:", "");

  if ((await getAppliedStoreThemeId()) !== themeId) return;

  const theme = change.newValue;
  if (!theme?.css) return;

  if (change.oldValue?.css === theme.css && change.oldValue?.version === theme.version) return;

  logCore("Store theme updated:", theme.title || themeId);
  applyCustomStyles(compileRicsToStyles(theme.css));
}

export function subscribeToCustomStyles(): void {
  if (hasSubscribedToStyles) {
    return;
  }
  hasSubscribedToStyles = true;

  subscribeStorageChanges(async (changes, area) => {
    if ((area === "sync" || area === "local") && changes.customCSS) {
      if (changes.customCSS.newValue) {
        let css = changes.customCSS.newValue as string;
        if (isCompressed(css)) {
          css = decompressStyles(css);
        }
        applyCustomStyles(compileRicsToStyles(css));
      }
    }

    if (area === "local") {
      for (const key of Object.keys(changes)) {
        if (key.startsWith("storeTheme:")) {
          await handleStoreThemeChange(key, changes[key]);
        }
      }
    }
  });
  getAndApplyCustomStyles();
}
