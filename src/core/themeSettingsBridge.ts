/**
 * Theme settings live in storage under `blyrics-*` keys (same contract as the legacy extension's
 * options page). `@braccato/core`'s `registerThemeSetting` registry starts from defaults at module
 * scope; without a feed it never sees what the user stored. This bridge reads every `blyrics-*`
 * key (local and `sync:`-prefixed), JSON-parses the values, and hands them to `setThemeSettings`.
 *
 * Player boot calls it once before mount; a storage-change subscription re-applies it live and
 * returns whether a lyrics rebuild is needed (the registry's `requiresLyricReload` flag).
 */

import { setThemeSettings } from "@braccato/core/themeSettings";
import { warnCore } from "@core/logger";

const PREFIX = "blyrics-";
const SYNC_PREFIX = "sync:";

function parseStored(raw: string): string | null {
  // Storage writes plain JSON for theme settings (setLocalStorage/setSyncStorage); tolerate raw
  // strings too so a hand-written value still lands.
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (typeof parsed === "boolean" || typeof parsed === "number") return String(parsed);
    return null; // objects/arrays are not theme settings
  } catch {
    return raw;
  }
}

function collectFrom(storage: Storage | undefined, into: Map<string, string>): void {
  if (!storage) return;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key) continue;
    const local = key.startsWith(SYNC_PREFIX) ? key.slice(SYNC_PREFIX.length) : key;
    if (!local.startsWith(PREFIX)) continue;
    const value = storage.getItem(key);
    if (value === null) continue;
    const parsed = parseStored(value);
    if (parsed !== null) into.set(local, parsed);
  }
}

/** Feeds every stored blyrics-* value into the theme-settings registry. Returns true if a lyrics rebuild was flagged. */
export function applyStoredThemeSettings(): boolean {
  try {
    const map = new Map<string, string>();
    collectFrom(typeof localStorage !== "undefined" ? localStorage : undefined, map);
    return map.size > 0 ? setThemeSettings(map) : false;
  } catch (error) {
    warnCore("Failed to apply stored theme settings:", error);
    return false;
  }
}
