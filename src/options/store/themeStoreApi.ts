import { THEME_STORE_API_URL } from "@constants";
import { fetchWithTimeout } from "./themeStoreService";
import type { AllThemeStats, ApiResult, ResolvedBuild } from "./types";
import { warnStore } from "@core/logger";

const RESOLVE_TIMEOUT_MS = 3000;

const THEME_ID_MAX_LENGTH = 128;
const THEME_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function isValidThemeId(themeId: string): boolean {
  return (
    typeof themeId === "string" &&
    themeId.length > 0 &&
    themeId.length <= THEME_ID_MAX_LENGTH &&
    THEME_ID_PATTERN.test(themeId)
  );
}


function isResolvedBuild(value: unknown): value is ResolvedBuild {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.version === "string" &&
    typeof candidate.minVersion === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.integrity === "string"
  );
}

/**
 * Asks the store-api which build of a theme to use for the given extension version.
 * Returns the resolved build on a 200 response, or null on timeout / network error /
 * non-200 / malformed payload so the caller can fall back to local resolution.
 */
export async function resolveThemeBuild(themeId: string, extensionVersion: string): Promise<ResolvedBuild | null> {
  if (!isValidThemeId(themeId)) {
    return null;
  }

  try {
    const url = `${THEME_STORE_API_URL}/api/resolve/${encodeURIComponent(themeId)}?ext=${encodeURIComponent(extensionVersion)}`;
    const response = await fetchWithTimeout(url, {}, RESOLVE_TIMEOUT_MS);

    if (!response.ok) {
      return null;
    }

    const data = await response.json().catch(() => null);
    if (!isResolvedBuild(data)) {
      warnStore(`Malformed resolve response for ${themeId}`);
      return null;
    }

    return data;
  } catch (err) {
    const error = err instanceof Error ? err.message : "Network error";
    warnStore(`Failed to resolve build for ${themeId}:`, error);
    return null;
  }
}

export async function fetchAllStats(): Promise<ApiResult<AllThemeStats>> {
  try {
    const response = await fetchWithTimeout(`${THEME_STORE_API_URL}/api/stats`);
    if (!response.ok) {
      const error = `Failed to fetch stats: ${response.status}`;
      warnStore(error);
      return { success: false, data: {}, error };
    }
    return { success: true, data: await response.json() };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Network error";
    warnStore("Failed to fetch stats:", error);
    return { success: false, data: {}, error };
  }
}



