import { THEME_DISCUSSIONS_URL, THEME_REGISTRY_URL } from "@constants";
import { resolveBuildForVersion } from "./themeBuildResolver";
import { resolveThemeBuild } from "./themeStoreApi";
import type { LockfileEntry, StoreTheme, StoreThemeMetadata, ThemeLockfile } from "./types";
import { warnStore } from "@core/logger";

import { version as EXTENSION_VERSION } from "../../../package.json";

const DEFAULT_TIMEOUT_MS = 10000;

const ALLOWED_IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;

function filterSafeImageFilenames(filenames: string[]): string[] {
  return filenames.filter(f => ALLOWED_IMAGE_EXTENSIONS.test(f));
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

interface BranchCacheEntry {
  branch: string;
  timestamp: number;
}

const BRANCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const repoBranchCache = new Map<string, BranchCacheEntry>();


function getRawGitHubUrl(repo: string, branch: string, path: string, bustCache = true): string {
  const base = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
  return bustCache ? `${base}?t=${Date.now()}` : base;
}

async function testBranchExists(repo: string, branch: string, testFile = "metadata.json"): Promise<boolean> {
  try {
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/${testFile}`;
    const response = await fetchWithTimeout(url, { method: "HEAD" }, 5000);
    return response.ok;
  } catch (err) {
    warnStore("Branch test failed:", err);
    return false;
  }
}

async function getDefaultBranch(repo: string, testFile = "metadata.json"): Promise<string> {
  const cached = repoBranchCache.get(repo);
  if (cached && Date.now() - cached.timestamp < BRANCH_CACHE_TTL_MS) {
    return cached.branch;
  }

  try {
    const response = await fetchWithTimeout(
      `https://api.github.com/repos/${repo}`,
      { headers: { Accept: "application/vnd.github.v3+json" } },
      5000
    );

    if (response.ok) {
      const data = await response.json();
      const branch = data.default_branch || "main";
      repoBranchCache.set(repo, { branch, timestamp: Date.now() });
      return branch;
    }
  } catch (err) {
    warnStore("GitHub API failed, falling back to branch testing:", err);
  }

  if (await testBranchExists(repo, "master", testFile)) {
    repoBranchCache.set(repo, { branch: "master", timestamp: Date.now() });
    return "master";
  }

  if (await testBranchExists(repo, "main", testFile)) {
    repoBranchCache.set(repo, { branch: "main", timestamp: Date.now() });
    return "main";
  }

  return "main";
}



function getLegacyRegistryPath(themeId: string): string {
  return `themes/${themeId}`;
}

function getRegistryFileUrl(basePath: string, file: string): string {
  return `${THEME_REGISTRY_URL}/${basePath}/${file}`;
}

function getLockfileUrl(): string {
  return `${THEME_REGISTRY_URL}/index.lock.json`;
}

async function fetchThemeLockfile(): Promise<ThemeLockfile> {
  const url = `${getLockfileUrl()}?t=${Date.now()}`;
  const response = await fetchWithTimeout(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Failed to fetch theme lockfile: ${response.status}`);
  }

  return response.json();
}

async function fetchRegistryMetadata(themeId: string, basePath: string): Promise<StoreThemeMetadata> {
  const url = getRegistryFileUrl(basePath, "metadata.json");
  const response = await fetchWithTimeout(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Failed to fetch metadata for ${themeId}: ${response.status}`);
  }

  return response.json();
}

async function fetchRegistryDescription(basePath: string): Promise<string | null> {
  const url = getRegistryFileUrl(basePath, "DESCRIPTION.md");

  try {
    const response = await fetchWithTimeout(url, { cache: "no-store" });
    if (!response.ok) return null;
    return response.text();
  } catch (err) {
    warnStore("Failed to fetch registry CSS:", err);
    return null;
  }
}

async function checkRegistryFileExists(basePath: string, file: string): Promise<boolean> {
  const url = getRegistryFileUrl(basePath, file);
  try {
    const response = await fetchWithTimeout(url, { method: "HEAD" }, 5000);
    return response.ok;
  } catch (err) {
    warnStore("Failed to check registry file:", err);
    return false;
  }
}

export async function fetchRegistryShaderConfig(basePath: string): Promise<Record<string, unknown> | null> {
  const url = getRegistryFileUrl(basePath, "shader.json");

  try {
    const response = await fetchWithTimeout(url, { cache: "no-store" });
    if (!response.ok) return null;
    return response.json();
  } catch (err) {
    warnStore("Failed to fetch registry shader config:", err);
    return null;
  }
}

/**
 * Local-only resolution used by the listing path: never hits store-api.
 * Order: local builds[] from the lockfile entry, then legacy latest.
 */
function resolveRegistryPathLocal(lockEntry: LockfileEntry): { path: string; integrity?: string } {
  if (lockEntry.builds && lockEntry.builds.length > 0) {
    const localResolved = resolveBuildForVersion(lockEntry.builds, EXTENSION_VERSION);
    if (localResolved) {
      return { path: localResolved.path, integrity: localResolved.integrity };
    }
  }

  return { path: getLegacyRegistryPath(lockEntry.id), integrity: lockEntry.integrity };
}

/**
 * Authoritative resolution used by the install/update path.
 * Order: store-api /resolve, then local builds[] from the lockfile entry, then legacy latest.
 */
async function resolveRegistryPathAuthoritative(
  lockEntry: LockfileEntry
): Promise<{ path: string; integrity?: string }> {
  const apiResolved = await resolveThemeBuild(lockEntry.id, EXTENSION_VERSION);
  if (apiResolved) {
    return { path: apiResolved.path, integrity: apiResolved.integrity };
  }

  return resolveRegistryPathLocal(lockEntry);
}

interface RegistryFileUrls {
  cssUrl: string;
  shaderUrl?: string;
  registryPath: string;
  integrity?: string;
}

/**
 * Derives the css (rics-then-css), shader, and base path for a resolved registry build.
 * Shared by the listing render and the install-time re-derivation.
 */
async function deriveRegistryFileUrls(
  basePath: string,
  hasShaders: boolean,
  integrity?: string
): Promise<RegistryFileUrls> {
  const hasRics = await checkRegistryFileExists(basePath, "style.rics");
  const cssUrl = hasRics ? getRegistryFileUrl(basePath, "style.rics") : getRegistryFileUrl(basePath, "style.css");
  const shaderUrl = hasShaders ? getRegistryFileUrl(basePath, "shader.json") : undefined;
  return { cssUrl, shaderUrl, registryPath: basePath, integrity };
}

/**
 * Install-time resolution for a registry theme. Calls the authoritative store-api /resolve first
 * (falling back to local builds[] then legacy), then re-derives the css/shader/base URLs from that
 * path so install uses the build chosen at install time rather than the listing-time URLs.
 */
export async function resolveRegistryInstallUrls(theme: StoreTheme): Promise<RegistryFileUrls> {
  const lockEntry: LockfileEntry = {
    repo: theme.repo,
    id: theme.id,
    version: theme.version,
    commit: theme.commit ?? "",
    integrity: theme.integrity ?? "",
    locked: theme.locked ?? "",
    builds: theme.builds,
  };

  const { path: basePath, integrity } = await resolveRegistryPathAuthoritative(lockEntry);
  return deriveRegistryFileUrls(basePath, theme.hasShaders, integrity);
}

async function fetchFullThemeFromRegistry(lockEntry: LockfileEntry): Promise<StoreTheme> {
  const themeId = lockEntry.id;

  const { path: basePath, integrity } = resolveRegistryPathLocal(lockEntry);

  const [metadata, descriptionMd] = await Promise.all([
    fetchRegistryMetadata(themeId, basePath),
    fetchRegistryDescription(basePath),
  ]);

  const description = descriptionMd ?? metadata.description ?? "";

  const { cssUrl, shaderUrl } = await deriveRegistryFileUrls(basePath, metadata.hasShaders);

  const imageUrls: string[] = [];
  const safeImages = metadata.images ? filterSafeImageFilenames(metadata.images) : [];
  for (const img of safeImages) {
    imageUrls.push(`${THEME_REGISTRY_URL}/${basePath}/images/${img}`);
  }

  let coverUrl: string;
  let allImageUrls: string[];

  if (imageUrls.length > 0) {
    coverUrl = imageUrls[0];
    allImageUrls = imageUrls;
  } else {
    coverUrl = `${THEME_REGISTRY_URL}/${basePath}/cover.png`;
    allImageUrls = [coverUrl];
  }

  const builds = lockEntry.builds;
  const latestBuild = builds && builds.length > 0 ? builds[0] : undefined;

  return {
    ...metadata,
    description,
    repo: lockEntry.repo,
    coverUrl,
    imageUrls: allImageUrls,
    cssUrl,
    shaderUrl,
    version: metadata.version ?? lockEntry.version,
    commit: lockEntry.commit,
    locked: lockEntry.locked,
    registryPath: basePath,
    integrity,
    builds,
    latestVersion: latestBuild?.version,
    latestMinVersion: latestBuild?.minVersion,
    discussionUrl: lockEntry.discussion ? `${THEME_DISCUSSIONS_URL}/${lockEntry.discussion}` : undefined,
  };
}


export async function fetchThemeCSS(repo: string, branchOverride?: string): Promise<{ css: string; isRics: boolean }> {
  const branch = branchOverride ?? (await getDefaultBranch(repo));

  const ricsUrl = getRawGitHubUrl(repo, branch, "style.rics");
  const ricsResponse = await fetchWithTimeout(ricsUrl, { cache: "no-store" }).catch(err => {
    warnStore("RICS fetch failed, trying CSS:", err);
    return null;
  });

  if (ricsResponse?.ok) {
    return { css: await ricsResponse.text(), isRics: true };
  }

  const cssUrl = getRawGitHubUrl(repo, branch, "style.css");
  const cssResponse = await fetchWithTimeout(cssUrl, { cache: "no-store" });

  if (!cssResponse.ok) {
    throw new Error(`Failed to fetch style file for ${repo}: no style.rics or style.css found`);
  }

  return { css: await cssResponse.text(), isRics: false };
}

async function checkFileExists(url: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(url, { method: "HEAD" }, 5000);
    return response.ok;
  } catch (err) {
    warnStore("File existence check failed:", err);
    return false;
  }
}

export async function fetchThemeShaderConfig(
  repo: string,
  branchOverride?: string
): Promise<Record<string, unknown> | null> {
  const branch = branchOverride ?? (await getDefaultBranch(repo));
  const url = getRawGitHubUrl(repo, branch, "shader.json");

  const exists = await checkFileExists(url);
  if (!exists) return null;

  try {
    const response = await fetchWithTimeout(url, { cache: "no-store" });
    if (!response.ok) return null;
    return response.json();
  } catch (err) {
    warnStore("Failed to fetch theme shader config:", err);
    return null;
  }
}



export async function fetchSingleStoreTheme(themeId: string): Promise<StoreTheme | null> {
  try {
    const lockfile = await fetchThemeLockfile();
    const entry = lockfile.themes.find(e => e.id === themeId);
    if (!entry) return null;
    return await fetchFullThemeFromRegistry(entry);
  } catch (err) {
    warnStore(`Failed to fetch single store theme ${themeId}:`, err);
    return null;
  }
}


export async function fetchStoreThemesByIds(ids: string[]): Promise<StoreTheme[]> {
  if (ids.length === 0) return [];

  const lockfile = await fetchThemeLockfile();
  const entryById = new Map(lockfile.themes.map(entry => [entry.id, entry]));
  const entries = ids.map(id => entryById.get(id)).filter((entry): entry is LockfileEntry => entry !== undefined);

  const results = await Promise.allSettled(entries.map(entry => fetchFullThemeFromRegistry(entry)));

  const themes: StoreTheme[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      themes.push(result.value);
    } else {
      warnStore("Failed to fetch featured theme:", result.reason);
    }
  }

  return themes;
}


