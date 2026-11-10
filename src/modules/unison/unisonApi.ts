import { UNISON_API_BASE_URL } from "@constants";
import { isKeyRegistered, markKeyRegistered, signPayload } from "@/core/keyIdentity";
import { fetchWithTimeout } from "@/options/store/themeStoreService";
import { UnisonErrorCode } from "./errorCodes";
import type { UnisonLyricsRequest, UnisonRequestSuccess } from "./types";
import { warnUnison } from "@core/logger";

// -- Helpers --------------------------

interface ApiResult<T> {
  success: boolean;
  data: T;
  error?: string;
  code?: string;
  hint?: string;
  status?: number;
}

interface UnisonErrorBody {
  error?: string;
  code?: string;
  hint?: string;
}
async function signedRequest<T>(
  endpoint: string,
  method: "POST" | "DELETE",
  data: Record<string, unknown>
): Promise<ApiResult<T>> {
  try {
    let signed = await signPayload(data);
    let needsRegistration = !(await isKeyRegistered());

    const body: Record<string, unknown> = {
      payload: signed.payload,
      signature: signed.signature,
    };

    if (needsRegistration) {
      body.publicKey = signed.publicKey;
    }

    let response = await fetchWithTimeout(`${UNISON_API_BASE_URL}${endpoint}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let cachedErrorBody: UnisonErrorBody | null = null;

    if (response.status === 400 && !needsRegistration) {
      cachedErrorBody = await response.json().catch(() => null);
      if (cachedErrorBody?.code === UnisonErrorCode.PUBLIC_KEY_REQUIRED) {
        signed = await signPayload(data);
        body.payload = signed.payload;
        body.signature = signed.signature;
        body.publicKey = signed.publicKey;
        needsRegistration = true;
        response = await fetchWithTimeout(`${UNISON_API_BASE_URL}${endpoint}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        cachedErrorBody = null;
      }
    }

    if (!response.ok) {
      const errorData: UnisonErrorBody | null = cachedErrorBody ?? (await response.json().catch(() => null));
      const error = errorData?.error ?? `Request failed: ${response.status}`;
      warnUnison(error);
      return {
        success: false,
        data: null as T,
        error,
        code: errorData?.code,
        hint: errorData?.hint,
        status: response.status,
      };
    }

    if (needsRegistration) {
      await markKeyRegistered();
    }

    const result = await response.json();
    return { success: true, data: result.data as T };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Network error";
    warnUnison(endpoint, error);
    return { success: false, data: null as T, error };
  }
}

// -- Public API --------------------------

export async function requestLyrics(request: UnisonLyricsRequest): Promise<ApiResult<UnisonRequestSuccess | null>> {
  return signedRequest<UnisonRequestSuccess | null>(
    "/requests",
    "POST",
    request as unknown as Record<string, unknown>
  );
}
