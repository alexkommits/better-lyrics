import { compressString } from "./compression";
import { getLocalStorage, isLyricCacheKey, removeLocalStorage, setLocalStorage } from "@core/storage";
import { errorCore, logCore } from "@core/logger";

const LOCAL_STORAGE_TOTAL = 5 * 1024 * 1024;
const COMPRESSION_THRESHOLD = 50000;
const SPACE_HEADROOM = 1.2;
const MAX_RETRY_ATTEMPTS = 3;

interface SaveResult {
  success: boolean;
  strategy?: "local";
  error?: any;
}

/** Theme records come from unvalidated metadata.json, so creators may be absent or not an array. */
export function formatCreators(creators: string[] | undefined): string {
  return Array.isArray(creators) && creators.length > 0 ? creators.join(", ") : "Unknown";
}

export function buildStoreThemeContent(title: string, creators: string[] | undefined, css: string): string {
  return `/* ${title}, a marketplace theme by ${formatCreators(creators)} */\n\n${css}\n`;
}

// -- Space Reclamation --------------------------

async function getStorageUsage(): Promise<{ used: number; total: number }> {
  const items = await getLocalStorage<Record<string, unknown>>(null);
  const used = Object.entries(items).reduce(
    (sum, [key, value]) => sum + key.length + JSON.stringify(value ?? null).length,
    0
  );
  return { used, total: LOCAL_STORAGE_TOTAL };
}

async function clearLyricsCacheIfNeeded(requiredSpace: number): Promise<void> {
  const usage = await getStorageUsage();
  const availableSpace = usage.total - usage.used;

  logCore(`Available space: ${availableSpace} bytes, Required: ${requiredSpace} bytes`);

  if (availableSpace < requiredSpace) {
    logCore("Not enough space, clearing lyrics cache...");
    const allData = await getLocalStorage<Record<string, unknown>>(null);
    const lyricsKeys = Object.keys(allData).filter(isLyricCacheKey);

    if (lyricsKeys.length > 0) {
      logCore(`Removing ${lyricsKeys.length} cached lyrics entries`);
      await removeLocalStorage(lyricsKeys);

      const newUsage = await getStorageUsage();
      logCore(`Storage after cache clear: ${newUsage.used} / ${newUsage.total} bytes`);
    }
  }
}

// -- Write Strategy --------------------------

/**
 * Saves the user's theme CSS to local storage, compressed when it is large enough to benefit.
 * Web storage has one area with ample room; the old sync/chunked strategies existed only for
 * chrome.storage.sync's 8 KB-per-item quota and are gone.
 */
export async function saveCustomCss(css: string, retryCount = 0): Promise<SaveResult> {
  try {
    const cssSize = new Blob([css]).size;
    logCore(`Saving CSS: ${cssSize} bytes (${(cssSize / 1024).toFixed(2)} KB)`);

    const shouldCompress = cssSize > COMPRESSION_THRESHOLD;
    const cssToStore = shouldCompress ? compressString(css) : css;
    const storedSize = new Blob([cssToStore]).size;

    if (shouldCompress) {
      const ratio = ((1 - storedSize / cssSize) * 100).toFixed(1);
      logCore(`Compressed: ${storedSize} bytes (${ratio}% reduction)`);
    }

    await clearLyricsCacheIfNeeded(storedSize * SPACE_HEADROOM);
    await setLocalStorage({ customCSS: cssToStore, cssCompressed: shouldCompress });

    return { success: true, strategy: "local" };
  } catch (error: any) {
    errorCore("Storage save attempt failed:", error);

    if (retryCount < MAX_RETRY_ATTEMPTS && /quota|storage/i.test(error?.message ?? "")) {
      try {
        logCore("Attempting storage retry after clearing lyric cache...");
        const allData = await getLocalStorage<Record<string, unknown>>(null);
        await removeLocalStorage(Object.keys(allData).filter(isLyricCacheKey));
        const shouldCompress = css.length > COMPRESSION_THRESHOLD;
        await setLocalStorage({ customCSS: shouldCompress ? compressString(css) : css, cssCompressed: shouldCompress });
        return { success: true, strategy: "local" };
      } catch (retryError) {
        errorCore("Storage retry failed:", retryError);
        return { success: false, error: retryError };
      }
    }

    return { success: false, error };
  }
}
