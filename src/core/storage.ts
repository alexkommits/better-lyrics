import {
  LYRIC_SOURCE_KEYS,
  OFFSET_STORAGE_PREFIX,
  PROVIDER_CONFIGS,
  type ProviderConfig,
  STORAGE_TRANSIENT_SET_LOG,
  type SyncType,
} from "@constants";
import { syncTypeForLyric } from "@modules/unison/syncType";
import { truncateSource } from "@utils";
import { compileWithDetails } from "rics";
import { compressString, decompressString, isCompressed } from "./compression";
import { errorCore, logCore, logError, warnCore } from "@core/logger";

/**
 * localStorage-backed replacement for the extension's chrome.storage.* API.
 *
 * Two areas share one localStorage origin: the plain key namespace ("local") and a
 * `sync:`-prefixed namespace ("sync") that used to be chrome's 8 KB-per-item sync area.
 * Everything is async to keep the old call sites unchanged. Writes announce themselves on a
 * BroadcastChannel so the other pages of the app (player, settings, editor) see storage
 * changes the way they did with chrome.storage.onChanged; subscribe with
 * subscribeStorageChanges().
 */

export const PROTECTED_STORAGE_KEYS = [
  "userIdentity",
  "identityRegistered",
  "userThemeRatings",
  "keyCertificate",
] as const;

const SYNC_AREA_PREFIX = "sync:";
const BROADCAST_CHANNEL_NAME = "blyrics-storage";
const CHANGED_EVENT = "blyrics-storage-changed";

type AreaName = "local" | "sync";

interface StorageChange {
  oldValue?: any;
  newValue?: any;
}

type StorageChanges = Record<string, StorageChange>;
type StorageChangeListener = (changes: StorageChanges, area: AreaName) => void;

const senderId = `blyrics-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const changeTarget = new EventTarget();
const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined" && typeof window !== "undefined"
    ? new BroadcastChannel(BROADCAST_CHANNEL_NAME)
    : null;

// Node's BroadcastChannel (used by the tsx self-checks, which also assign a JSDOM window)
// keeps the event loop alive forever; the browser one does not. unref when available.
(channel as (BroadcastChannel & { unref?: () => void }) | null)?.unref?.();

if (channel) {
  channel.onmessage = event => {
    const message = event.data as { sender?: string; area?: AreaName; changes?: StorageChanges } | null;
    if (!message || message.sender === senderId || !message.area || !message.changes) return;
    // Apply remote writes without re-announcing them, then notify local listeners.
    for (const [key, change] of Object.entries(message.changes)) {
      applyToArea(message.area, key, change.newValue);
    }
    emitChange(message.area, message.changes);
  };
}

function areaStorageKey(area: AreaName, key: string): string {
  return area === "sync" ? SYNC_AREA_PREFIX + key : key;
}

function applyToArea(area: AreaName, key: string, newValue: unknown): void {
  const storageKey = areaStorageKey(area, key);
  try {
    if (newValue === undefined) {
      localStorage.removeItem(storageKey);
    } else {
      localStorage.setItem(storageKey, JSON.stringify(newValue));
    }
  } catch (error) {
    logError(error);
  }
}

function readArea(area: AreaName): Record<string, any> {
  const items: Record<string, any> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const rawKey = localStorage.key(i);
      if (rawKey === null) continue;
      const isSyncKey = rawKey.startsWith(SYNC_AREA_PREFIX);
      if ((area === "sync") !== isSyncKey) continue;
      const key = isSyncKey ? rawKey.slice(SYNC_AREA_PREFIX.length) : rawKey;
      const raw = localStorage.getItem(rawKey);
      if (raw === null) continue;
      try {
        items[key] = JSON.parse(raw);
      } catch {
        // Tolerate raw strings written by older builds or dev tools.
        items[key] = raw;
      }
    }
  } catch (error) {
    logError(error);
  }
  return items;
}

function bytesOfKey(area: AreaName, key: string, value: unknown): number {
  return areaStorageKey(area, key).length + JSON.stringify(value ?? null).length;
}

function selectKeys(items: Record<string, any>, keys: string | string[] | Record<string, any> | null | undefined) {
  if (keys === null || keys === undefined) return { ...items };
  if (typeof keys === "string") return keys in items ? { [keys]: items[keys] } : {};
  if (Array.isArray(keys)) {
    const selected: Record<string, any> = {};
    for (const key of keys) {
      if (key in items) selected[key] = items[key];
    }
    return selected;
  }
  // Chrome accepts an object of defaults; missing keys fall back to their default.
  const selected: Record<string, any> = {};
  for (const [key, defaultValue] of Object.entries(keys)) {
    selected[key] = key in items ? items[key] : defaultValue;
  }
  return selected;
}

function emitChange(area: AreaName, changes: StorageChanges): void {
  if (Object.keys(changes).length === 0) return;
  changeTarget.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { area, changes } }));
}

function announceChange(area: AreaName, changes: StorageChanges): void {
  if (Object.keys(changes).length === 0 || !channel) return;
  try {
    channel.postMessage({ sender: senderId, area, changes });
  } catch (error) {
    warnCore("Failed to broadcast storage change:", error);
  }
}

async function writeArea(area: AreaName, items: Record<string, any>): Promise<void> {
  if (!items || typeof items !== "object") return;
  const before = readArea(area);
  const changes: StorageChanges = {};
  for (const [key, value] of Object.entries(items)) {
    if (value === undefined) {
      warnCore(`Skipping storage write of undefined value for key "${key}"`);
      continue;
    }
    try {
      localStorage.setItem(areaStorageKey(area, key), JSON.stringify(value));
      changes[key] = { oldValue: before[key], newValue: value };
    } catch (error) {
      // Quota exceeded or storage unavailable; report and keep the in-memory copy out of sync.
      logError(error);
    }
  }
  emitChange(area, changes);
  announceChange(area, changes);
}

async function removeArea(area: AreaName, keys: string | string[]): Promise<void> {
  const keyList = typeof keys === "string" ? [keys] : keys;
  const before = readArea(area);
  const changes: StorageChanges = {};
  for (const key of keyList) {
    try {
      localStorage.removeItem(areaStorageKey(area, key));
      changes[key] = { oldValue: before[key], newValue: undefined };
    } catch (error) {
      logError(error);
    }
  }
  emitChange(area, changes);
  announceChange(area, changes);
}

export function subscribeStorageChanges(listener: StorageChangeListener): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent).detail as { area: AreaName; changes: StorageChanges };
    listener(detail.changes, detail.area);
  };
  changeTarget.addEventListener(CHANGED_EVENT, handler);
  return () => changeTarget.removeEventListener(CHANGED_EVENT, handler);
}

/**
 * Typed wrapper for storage.local.get that casts results to the expected type.
 * Accepts a key, a list of keys, an object of defaults (missing keys fall back to their default),
 * or null for the whole area.
 */
export async function getLocalStorage<T = any>(keys: string | string[] | Record<string, any> | null): Promise<T> {
  return selectKeys(readArea("local"), keys) as T;
}

/**
 * Typed wrapper for storage.sync.get. The sync area lives under a `sync:` key prefix in the
 * same localStorage origin; see the module comment.
 */
export async function getSyncStorage<T = any>(keys: string | string[] | Record<string, any> | null): Promise<T> {
  return selectKeys(readArea("sync"), keys) as T;
}

export async function setLocalStorage(items: Record<string, any>): Promise<void> {
  await writeArea("local", items);
}

export async function setSyncStorage(items: Record<string, any>): Promise<void> {
  await writeArea("sync", items);
}

export async function removeLocalStorage(keys: string | string[]): Promise<void> {
  await removeArea("local", keys);
}

export async function removeSyncStorage(keys: string | string[]): Promise<void> {
  await removeArea("sync", keys);
}

export const STORE_THEME_PREFIX = "store:";

/** Null once edited: editing drops themeName but leaves activeStoreTheme set. */
export async function getAppliedStoreThemeId(): Promise<string | null> {
  const { themeName } = await getSyncStorage<{ themeName?: string }>(["themeName"]);
  if (!themeName?.startsWith(STORE_THEME_PREFIX)) return null;
  return themeName.slice(STORE_THEME_PREFIX.length) || null;
}

interface TransientStorageItem {
  type: "transient";
  value: any;
  expiry: number;
}

function isExpired(expiry: number | undefined, now = Date.now()): boolean {
  return Boolean(expiry && now >= expiry);
}

const COMPILE_TIMEOUT = 3000;
const MAX_ITERATIONS = 10000;
const HARD_TIMEOUT = 5000;

export function compileRicsToStyles(sourceCode: string): string {
  try {
    const startTime = performance.now();
    const result = compileWithDetails(sourceCode, {
      timeout: COMPILE_TIMEOUT,
      maxIterations: MAX_ITERATIONS,
    });
    const elapsed = performance.now() - startTime;

    if (elapsed > HARD_TIMEOUT) {
      logError(`rics compilation timeout: took ${elapsed.toFixed(0)}ms\nSource:\n${truncateSource(sourceCode)}`);
      return sourceCode;
    }

    if (result.errors.length > 0) {
      logError(`rics compilation errors: ${JSON.stringify(result.errors)}\nSource:\n${truncateSource(sourceCode)}`);
      return sourceCode;
    }
    return result.css;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`rics compilation failed: ${message}\nSource:\n${truncateSource(sourceCode)}`);
    return sourceCode;
  }
}

/** Raw envelope read; null when absent or unparsable. Value is decompressed when it was stored compressed. */
function readTransientEnvelope(key: string): TransientStorageItem | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(areaStorageKey("local", key));
  } catch (error) {
    logError(error);
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as TransientStorageItem;
    if (!parsed || typeof parsed !== "object" || !("value" in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function decodeTransientValue(value: any): any {
  return typeof value === "string" && isCompressed(value) ? decompressString(value) : value;
}


/**
 * Callback-style accessor for the sync area, kept for the settings page's option wiring.
 * Prefer getSyncStorage() in new code.
 */
export function getStorage(
  key: string | string[] | { [key: string]: any },
  callback: (items: { [key: string]: any }) => void
): void {
  void getSyncStorage(key).then(callback);
}

/**
 * Fire-and-forget setter for the sync area, kept for the settings page's option wiring.
 * Prefer setSyncStorage() in new code.
 */
export function setStorage(items: { [key: string]: any }): void {
  void setSyncStorage(items);
}

export async function getTransientStorage(key: string): Promise<any | null> {
  const item = readTransientEnvelope(key);
  if (!item) return null;

  if (isExpired(item.expiry)) {
    try {
      const before = readArea("local");
      localStorage.removeItem(areaStorageKey("local", key));
      emitChange("local", { [key]: { oldValue: before[key], newValue: undefined } });
    } catch (error) {
      logError(error);
    }
    return null;
  }

  return decodeTransientValue(item.value);
}

/**
 * Stores a value with an automatic expiry. String values are compressed.
 */
export async function setTransientStorage(key: string, value: any, ttl: number): Promise<void> {
  try {
    const expiry = Date.now() + ttl;
    const storedValue = typeof value === "string" ? compressString(value) : value;

    const before = readArea("local");
    localStorage.setItem(
      areaStorageKey("local", key),
      JSON.stringify({ type: "transient", value: storedValue, expiry } satisfies TransientStorageItem)
    );
    logCore(STORAGE_TRANSIENT_SET_LOG, key);
    emitChange("local", { [key]: { oldValue: before[key], newValue: { type: "transient", value: storedValue, expiry } } });
    announceChange("local", {
      [key]: { oldValue: before[key], newValue: { type: "transient", value: storedValue, expiry } },
    });
  } catch (error) {
    logError(error);
  } finally {
    await saveCacheInfo().catch(error => errorCore("Failed to refresh the cache stat:", error));
  }
}

/**
 * Stores a value with no expiry, so it survives cache purges.
 * Used for durable per-song data such as saved lyric offsets.
 */
export async function setPersistentStorage(key: string, value: any): Promise<void> {
  try {
    const storedValue = typeof value === "string" ? compressString(value) : value;
    const before = readArea("local");
    localStorage.setItem(
      areaStorageKey("local", key),
      JSON.stringify({ type: "transient", value: storedValue, expiry: 0 } satisfies TransientStorageItem)
    );
    emitChange("local", {
      [key]: { oldValue: before[key], newValue: { type: "transient", value: storedValue, expiry: 0 } },
    });
    announceChange("local", {
      [key]: { oldValue: before[key], newValue: { type: "transient", value: storedValue, expiry: 0 } },
    });
  } catch (error) {
    logError(error);
  }
}

const LYRIC_CACHE_PREFIX = "blyrics_";
// Unison keeps one entry per song for its four sources.
const LYRIC_CACHE_SUFFIXES = [...LYRIC_SOURCE_KEYS, "metadata", "unison"].map(sourceKey => `_${sourceKey}`);

function parseLyricCacheKey(key: string): { videoId: string; source: string } | null {
  if (!key.startsWith(LYRIC_CACHE_PREFIX)) return null;
  const withoutPrefix = key.slice(LYRIC_CACHE_PREFIX.length);
  for (const suffix of LYRIC_CACHE_SUFFIXES) {
    if (withoutPrefix.length > suffix.length && withoutPrefix.endsWith(suffix)) {
      return { videoId: withoutPrefix.slice(0, -suffix.length), source: suffix.slice(1) };
    }
  }
  return null;
}

export function isLyricCacheKey(key: string): boolean {
  return parseLyricCacheKey(key) !== null;
}

// -- Storage breakdown --------------------------

type StorageCategory = "lyrics" | "themes" | "offsets" | "other";

const THEME_STORAGE_KEYS = new Set([
  "storeThemeIndex",
  "customThemes",
  "customCSS",
  "customCSS_chunked",
  "customCSS_chunkCount",
  "cssCompressed",
  "userThemeRatings",
  "userThemeInstalls",
  "blyrics_featured_themes",
]);
const THEME_STORAGE_PREFIXES = ["storeTheme:", "customCSS_chunk_"];

export function storageCategoryForKey(key: string): StorageCategory {
  if (isLyricCacheKey(key)) return "lyrics";
  if (THEME_STORAGE_KEYS.has(key) || THEME_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix))) return "themes";
  if (key.startsWith(OFFSET_STORAGE_PREFIX)) return "offsets";
  return "other";
}

const PROVIDER_BY_KEY = new Map<string, ProviderConfig>(PROVIDER_CONFIGS.map(config => [config.key, config]));
const MISS_PAYLOAD_MAX_CHARS = 512;

function isMissEntry(item: unknown): boolean {
  const value = (item as { value?: unknown } | null)?.value;
  if (typeof value !== "string" || value.length > MISS_PAYLOAD_MAX_CHARS) return false;
  try {
    return JSON.parse(decompressString(value))?.missing === true;
  } catch {
    return false;
  }
}

function unisonCacheProvider(item: unknown): ProviderConfig | undefined {
  const value = (item as { value?: unknown } | null)?.value;
  if (typeof value !== "string") return undefined;
  try {
    const cachedLyric = JSON.parse(decompressString(value))?.lookup?.data;
    if (!cachedLyric?.lyrics) return undefined;
    const syncType = syncTypeForLyric(cachedLyric.syncType, cachedLyric.format);
    return PROVIDER_CONFIGS.find(config => config.key.startsWith("unison-") && config.syncType === syncType);
  } catch {
    return undefined;
  }
}

function cachedProvider(source: string, item: unknown): ProviderConfig | undefined {
  if (source === "unison") return unisonCacheProvider(item);
  return isMissEntry(item) ? undefined : PROVIDER_BY_KEY.get(source);
}

interface LyricCacheSummary {
  songs: number;
  bySyncType: Record<SyncType, number>;
}

export function summarizeLyricCache(items: Record<string, unknown>): LyricCacheSummary {
  const best = new Map<string, { priority: number; syncType: SyncType }>();
  for (const [key, item] of Object.entries(items)) {
    const parsed = parseLyricCacheKey(key);
    if (!parsed || isExpired((item as { expiry?: number } | null)?.expiry)) continue;
    const provider = cachedProvider(parsed.source, item);
    if (!provider) continue;
    const current = best.get(parsed.videoId);
    if (!current || provider.priority < current.priority) {
      best.set(parsed.videoId, { priority: provider.priority, syncType: provider.syncType });
    }
  }
  const bySyncType: Record<SyncType, number> = { syllable: 0, word: 0, line: 0, unsynced: 0 };
  for (const { syncType } of best.values()) bySyncType[syncType]++;
  return { songs: best.size, bySyncType };
}

interface StorageBreakdown {
  lyrics: LyricCacheSummary;
  bytes: Record<StorageCategory, number>;
  totalBytes: number;
}

const STORAGE_CATEGORIES: StorageCategory[] = ["lyrics", "themes", "offsets", "other"];

function estimateBytes(items: Record<string, unknown>, keys: string[]): number {
  return keys.reduce((sum, key) => sum + key.length + JSON.stringify(items[key]).length, 0);
}

export async function getStorageBreakdown(): Promise<StorageBreakdown> {
  const items = readArea("local");
  const keysByCategory = Object.fromEntries(STORAGE_CATEGORIES.map(category => [category, [] as string[]])) as Record<
    StorageCategory,
    string[]
  >;
  for (const key of Object.keys(items)) keysByCategory[storageCategoryForKey(key)].push(key);
  // localStorage has no getBytesInUse; report the JSON-encoded size, like the Firefox path always did.
  const sizes = STORAGE_CATEGORIES.map(category => estimateBytes(items, keysByCategory[category]));
  const bytes = Object.fromEntries(STORAGE_CATEGORIES.map((category, i) => [category, sizes[i]])) as Record<
    StorageCategory,
    number
  >;
  return {
    lyrics: summarizeLyricCache(items),
    bytes,
    totalBytes: sizes.reduce((sum, size) => sum + size, 0),
  };
}

/**
 * Calculates current cache information including count and size of stored lyrics.
 * Count represents unique songs (by cache id), not individual cache entries.
 */
export async function getUpdatedCacheInfo(): Promise<{ count: number; size: number }> {
  const result = readArea("local");
  const lyricsKeys = Object.keys(result).filter(isLyricCacheKey);

  const uniqueVideoIds = new Set<string>();
  for (const key of lyricsKeys) {
    const videoId = parseLyricCacheKey(key)?.videoId;
    if (videoId) {
      uniqueVideoIds.add(videoId);
    }
  }

  const totalSize = lyricsKeys.reduce((acc, key) => {
    return acc + JSON.stringify(result[key]).length;
  }, 0);

  return {
    count: uniqueVideoIds.size,
    size: totalSize,
  };
}

/**
 * Updates and saves current cache information to the sync area.
 */
async function saveCacheInfo(): Promise<void> {
  const cacheInfo = await getUpdatedCacheInfo();
  await setSyncStorage({ cacheInfo });
}

export async function refreshCacheInfo(): Promise<{ count: number; size: number }> {
  const cacheInfo = await getUpdatedCacheInfo();
  await setSyncStorage({ cacheInfo }).catch(error => errorCore("Failed to save cache info:", error));
  return cacheInfo;
}

export async function clearLyricCache(): Promise<{ count: number; size: number }> {
  const result = readArea("local");
  await removeLocalStorage(Object.keys(result).filter(isLyricCacheKey));
  return refreshCacheInfo();
}

export async function clearSongCache(videoId: string): Promise<void> {
  if (!videoId) return;
  try {
    const prefix = `blyrics_${videoId}_`;
    const result = readArea("local");
    const songKeys = Object.keys(result).filter(
      key => key.startsWith(prefix) && !PROTECTED_STORAGE_KEYS.includes(key as (typeof PROTECTED_STORAGE_KEYS)[number])
    );
    await removeLocalStorage(songKeys);
    await saveCacheInfo();
  } catch (error) {
    logError(error);
  }
}



