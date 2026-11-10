import {
  getLocalStorage,
  removeLocalStorage,
  setLocalStorage,
  setSyncStorage,
} from "@core/storage";
import {
  fetchRegistryShaderConfig,
  fetchSingleStoreTheme,
  fetchThemeCSS,
  fetchThemeShaderConfig,
  resolveRegistryInstallUrls,
} from "./themeStoreService";
import type { InstalledStoreTheme, StoreTheme, ThemeSource } from "./types";
import { logStore, warnStore } from "@core/logger";

async function fetchCssFromUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch CSS from ${url}: ${response.status}`);
  }
  return response.text();
}

interface InstallOptions {
  source?: ThemeSource;
  sourceUrl?: string;
  branch?: string;
}

async function installTheme(theme: StoreTheme, options: InstallOptions = {}): Promise<InstalledStoreTheme> {
  await ensureMigrated();

  const isRegistryTheme = !!theme.commit && options.source !== "url";

  let css: string;
  let shaderConfig: Record<string, unknown> | null = null;

  if (isRegistryTheme) {
    // Authoritative resolution happens here at install time: ask store-api /resolve
    // (falling back to local builds[] then legacy) and re-derive the file URLs from
    // that path rather than reusing the listing-time URLs.
    const installUrls = await resolveRegistryInstallUrls(theme);
    css = await fetchCssFromUrl(installUrls.cssUrl);
    if (theme.hasShaders) {
      shaderConfig = await fetchRegistryShaderConfig(installUrls.registryPath);
    }
  } else {
    const branch = options.branch;
    const cssResult = await fetchThemeCSS(theme.repo, branch);
    css = cssResult.css;
    if (theme.hasShaders) {
      shaderConfig = await fetchThemeShaderConfig(theme.repo, branch);
    }
  }

  const installedTheme: InstalledStoreTheme = {
    id: theme.id,
    repo: theme.repo,
    title: theme.title,
    creators: theme.creators,
    css,
    shaderConfig: shaderConfig || undefined,
    installedAt: Date.now(),
    version: theme.version,
    source: options.source,
    sourceUrl: options.sourceUrl,
    branch: options.branch,
    description: theme.description,
    coverUrl: theme.coverUrl,
    imageUrls: theme.imageUrls,
    minVersion: theme.minVersion,
    hasShaders: theme.hasShaders,
    tags: theme.tags,
    commit: theme.commit,
  };

  await setLocalStorage({ [getThemeStorageKey(theme.id)]: installedTheme });

  const index = await getThemeIndex();
  if (!index.themeIds.includes(theme.id)) {
    index.themeIds.push(theme.id);
    await setThemeIndex(index);
  }

  return installedTheme;
}

const THEME_INDEX_KEY = "storeThemeIndex";
const THEME_PREFIX = "storeTheme:";
const ACTIVE_STORE_THEME_KEY = "activeStoreTheme";

const LEGACY_STORAGE_KEY = "installedStoreThemes";

interface ThemeIndex {
  themeIds: string[];
}

async function getThemeIndex(): Promise<ThemeIndex> {
  const result = await getLocalStorage<{ [THEME_INDEX_KEY]?: ThemeIndex }>([THEME_INDEX_KEY]);
  return result[THEME_INDEX_KEY] || { themeIds: [] };
}

async function setThemeIndex(index: ThemeIndex): Promise<void> {
  await setLocalStorage({ [THEME_INDEX_KEY]: index });
}

function getThemeStorageKey(themeId: string): string {
  return `${THEME_PREFIX}${themeId}`;
}

async function migrateFromLegacyStorage(): Promise<void> {
  const result = await getLocalStorage<{ [LEGACY_STORAGE_KEY]?: InstalledStoreTheme[] }>([LEGACY_STORAGE_KEY]);
  const legacyThemes = result[LEGACY_STORAGE_KEY];

  if (!legacyThemes || legacyThemes.length === 0) return;

  logStore(`Migrating ${legacyThemes.length} themes from legacy storage`);

  const themeIds: string[] = [];

  for (const theme of legacyThemes) {
    try {
      await setLocalStorage({ [getThemeStorageKey(theme.id)]: theme });
      themeIds.push(theme.id);
    } catch (err) {
      warnStore(`Failed to migrate theme ${theme.id}:`, err);
    }
  }

  await setThemeIndex({ themeIds });
  await removeLocalStorage(LEGACY_STORAGE_KEY);

  logStore(`Migration complete: ${themeIds.length} themes migrated`);
}

let migrationPromise: Promise<void> | null = null;

async function ensureMigrated(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = migrateFromLegacyStorage();
  }
  await migrationPromise;
}

export async function getInstalledStoreThemes(): Promise<InstalledStoreTheme[]> {
  await ensureMigrated();

  const index = await getThemeIndex();
  if (index.themeIds.length === 0) return [];

  const keys = index.themeIds.map(getThemeStorageKey);
  const result = await getLocalStorage<Record<string, InstalledStoreTheme | undefined>>(keys);

  const themes: InstalledStoreTheme[] = [];
  const validIds: string[] = [];

  for (const id of index.themeIds) {
    const theme = result[getThemeStorageKey(id)];
    if (theme) {
      themes.push(theme);
      validIds.push(id);
    }
  }

  if (validIds.length !== index.themeIds.length) {
    await setThemeIndex({ themeIds: validIds });
  }

  return themes;
}


export async function getInstalledTheme(themeId: string): Promise<InstalledStoreTheme | null> {
  await ensureMigrated();
  const key = getThemeStorageKey(themeId);
  const result = await getLocalStorage<Record<string, InstalledStoreTheme | undefined>>([key]);
  return result[key] || null;
}





export async function setActiveStoreTheme(themeId: string): Promise<void> {
  await setSyncStorage({ [ACTIVE_STORE_THEME_KEY]: themeId });
}



// -- Symlinked Theme Installs --------------------------

export async function installSymlinkedThemeFromMarketplace(storeId: string): Promise<InstalledStoreTheme | null> {
  logStore(`Installing symlinked theme from marketplace: ${storeId}`);

  const existing = await getInstalledTheme(storeId);
  if (existing) {
    logStore(`Symlinked theme already installed: ${storeId} v${existing.version}`);
    return existing;
  }

  try {
    const storeTheme = await fetchSingleStoreTheme(storeId);
    if (!storeTheme) {
      warnStore(`Symlinked theme not found in marketplace: ${storeId}`);
      return null;
    }

    const installed = await installTheme(storeTheme, { source: "marketplace" });
    logStore(`Installed symlinked theme: ${storeId} v${installed.version}`);
    return installed;
  } catch (err) {
    warnStore(`Failed to install symlinked theme from marketplace: ${storeId}`, err);
    return null;
  }
}






