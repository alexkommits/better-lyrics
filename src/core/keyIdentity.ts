import { IDENTITY_ACTIONS, IDENTITY_ADJECTIVES, IDENTITY_NOUNS } from "@constants";
import { getLocalStorage, removeLocalStorage, setLocalStorage } from "./storage";
import { warnCore } from "@core/logger";

// -- Types ------------------------------------

interface KeyIdentity {
  keyId: string;
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
  createdAt: number;
}

interface SignedPayload<T = Record<string, unknown>> {
  payload: T & { timestamp: number; nonce: string; keyId: string };
  signature: string;
  publicKey: JsonWebKey;
}

interface IdentityExport {
  version: 1;
  keyId: string;
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
  exportedAt: number;
  certificate?: string;
}

// -- Constants --------------------------------

const STORAGE_KEY = "userIdentity";
const REGISTERED_KEY = "identityRegistered";
const CERTIFICATE_KEY = "keyCertificate";
const DISPLAY_NAME_KEY = "identityDisplayName";
const ECDSA_PARAMS: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const HASH_ALGORITHM = "SHA-256";

let cachedIdentity: Promise<KeyIdentity> | null = null;
let importCount = 0;
let identityCommits: Promise<unknown> = Promise.resolve();

function queueIdentityCommit<T>(commit: () => Promise<T>): Promise<T> {
  const run = identityCommits.then(commit);
  identityCommits = Promise.allSettled([run]);
  return run;
}

// -- Public API -------------------------------


export function getIdentity(): Promise<KeyIdentity> {
  if (cachedIdentity) return cachedIdentity;
  const pending: Promise<KeyIdentity> = loadOrCreateIdentity().catch(error => {
    if (cachedIdentity === pending) cachedIdentity = null;
    throw error;
  });
  cachedIdentity = pending;
  return pending;
}

async function loadOrCreateIdentity(): Promise<KeyIdentity> {
  const importsAtStart = importCount;
  const importedMeanwhile = (): boolean => importCount !== importsAtStart;
  const stored = await loadFromStorage();
  if (importedMeanwhile()) return getIdentity();
  if (stored) return stored;

  const generated = await generateKeyIdentity();
  const storedMeanwhile = await loadFromStorage();
  if (importedMeanwhile()) return getIdentity();
  if (storedMeanwhile) return storedMeanwhile;

  const saved = await queueIdentityCommit(async () => {
    if (importedMeanwhile()) return false;
    await saveToStorage(generated);
    return true;
  });
  return saved ? generated : getIdentity();
}



interface SignPayloadOptions {
  nonce?: string;
}

export async function signPayload<T extends Record<string, unknown>>(
  data: T,
  options?: SignPayloadOptions
): Promise<SignedPayload<T>> {
  const identity = await getIdentity();

  const payload = {
    ...data,
    timestamp: Date.now(),
    nonce: options?.nonce ?? crypto.randomUUID(),
    keyId: identity.keyId,
  };

  const payloadString = canonicalJson(payload);
  const payloadBuffer = new TextEncoder().encode(payloadString);

  const privateKey = await crypto.subtle.importKey("jwk", identity.privateKey, ECDSA_PARAMS, false, ["sign"]);

  const signatureBuffer = await crypto.subtle.sign({ name: "ECDSA", hash: HASH_ALGORITHM }, privateKey, payloadBuffer);

  return {
    payload,
    signature: bufferToBase64(signatureBuffer),
    publicKey: identity.publicKey,
  };
}


export async function importIdentity(json: string): Promise<KeyIdentity> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid JSON format");
  }

  if (!isValidIdentityExport(parsed)) {
    throw new Error("Invalid identity export format");
  }

  const computedKeyId = await hashPublicKey(parsed.publicKey);
  if (computedKeyId !== parsed.keyId) {
    throw new Error("Key ID mismatch - file may be corrupted");
  }

  const identity: KeyIdentity = {
    keyId: parsed.keyId,
    publicKey: parsed.publicKey,
    privateKey: parsed.privateKey,
    createdAt: Date.now(),
  };

  importCount++;
  const committed = queueIdentityCommit(() => commitImportedIdentity(identity, parsed.certificate));
  cachedIdentity = committed;
  try {
    await committed;
  } catch (error) {
    if (cachedIdentity === committed) cachedIdentity = null;
    throw error;
  }
  invalidateDisplayName();

  return identity;
}

async function commitImportedIdentity(identity: KeyIdentity, certificate: string | undefined): Promise<KeyIdentity> {
  await saveToStorage(identity);
  await removeLocalStorage(REGISTERED_KEY);
  if (certificate) {
    await setCertificate(certificate);
  } else {
    await clearCertificate();
  }
  return identity;
}







export async function getLastKnownDisplayName(): Promise<string> {
  const { keyId } = await getIdentity();
  const result = await getLocalStorage<{ [DISPLAY_NAME_KEY]?: { keyId?: unknown; displayName?: unknown } }>([
    DISPLAY_NAME_KEY,
  ]);
  const remembered = result[DISPLAY_NAME_KEY];
  if (remembered?.keyId === keyId && typeof remembered.displayName === "string") return remembered.displayName;
  return generatePetName(keyId);
}

function rememberDisplayName(keyId: string, displayName: string): void {
  setLocalStorage({ [DISPLAY_NAME_KEY]: { keyId, displayName } }).catch((err: unknown) =>
    warnCore("Failed to remember the display name:", err)
  );
}

function invalidateDisplayName(newValue?: string): void {
  if (newValue === undefined) return;
  getIdentity()
    .then(({ keyId }) => rememberDisplayName(keyId, newValue))
    .catch(err => warnCore("Failed to remember the display name:", err));
}

export async function forgetDisplayName(): Promise<void> {
  invalidateDisplayName();
  await removeLocalStorage(DISPLAY_NAME_KEY).catch(err => warnCore("Failed to forget the display name:", err));
}

export async function isKeyRegistered(): Promise<boolean> {
  const result = await getLocalStorage<{ [REGISTERED_KEY]?: boolean }>([REGISTERED_KEY]);
  return result[REGISTERED_KEY] === true;
}

export async function markKeyRegistered(): Promise<void> {
  await setLocalStorage({ [REGISTERED_KEY]: true });
}


async function setCertificate(certificate: string): Promise<void> {
  await setLocalStorage({ [CERTIFICATE_KEY]: certificate });
}


async function clearCertificate(): Promise<void> {
  await removeLocalStorage(CERTIFICATE_KEY);
}

// -- Private Helpers --------------------------

async function generateKeyIdentity(): Promise<KeyIdentity> {
  const keyPair = await crypto.subtle.generateKey(ECDSA_PARAMS, true, ["sign", "verify"]);

  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

  const keyId = await hashPublicKey(publicKeyJwk);

  return {
    keyId,
    publicKey: publicKeyJwk,
    privateKey: privateKeyJwk,
    createdAt: Date.now(),
  };
}

async function hashPublicKey(jwk: JsonWebKey): Promise<string> {
  // Normalize: only include fields that define the EC key identity
  // This ensures the same key produces the same hash regardless of optional fields
  const normalized = {
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  };
  const canonical = canonicalJson(normalized);
  const buffer = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest(HASH_ALGORITHM, buffer);
  return bufferToHex(hashBuffer);
}

export function generatePetName(keyId: string): string {
  const adjIndex = parseInt(keyId.slice(0, 2), 16) % IDENTITY_ADJECTIVES.length;
  const nounIndex = parseInt(keyId.slice(2, 4), 16) % IDENTITY_NOUNS.length;
  const actionIndex = parseInt(keyId.slice(4, 6), 16) % IDENTITY_ACTIONS.length;
  return `${IDENTITY_ADJECTIVES[adjIndex]}${IDENTITY_NOUNS[nounIndex]}${IDENTITY_ACTIONS[actionIndex]}`;
}

async function loadFromStorage(): Promise<KeyIdentity | null> {
  const result = await getLocalStorage<{ [STORAGE_KEY]?: KeyIdentity }>([STORAGE_KEY]);
  const stored = result[STORAGE_KEY];

  if (stored && isValidKeyIdentity(stored)) {
    return stored;
  }

  return null;
}

async function saveToStorage(identity: KeyIdentity): Promise<void> {
  await setLocalStorage({ [STORAGE_KEY]: identity });
}

function isValidPublicJwk(obj: unknown): obj is JsonWebKey {
  if (!obj || typeof obj !== "object") return false;
  const jwk = obj as Record<string, unknown>;
  return jwk.kty === "EC" && jwk.crv === "P-256" && typeof jwk.x === "string" && typeof jwk.y === "string";
}

function isValidPrivateJwk(obj: unknown): obj is JsonWebKey {
  if (!isValidPublicJwk(obj)) return false;
  const jwk = obj as Record<string, unknown>;
  return typeof jwk.d === "string";
}

function isValidKeyIdentity(obj: unknown): obj is KeyIdentity {
  if (!obj || typeof obj !== "object") return false;

  const candidate = obj as Record<string, unknown>;

  return (
    typeof candidate.keyId === "string" &&
    candidate.keyId.length === 64 &&
    (candidate.displayName === undefined || typeof candidate.displayName === "string") &&
    typeof candidate.createdAt === "number" &&
    isValidPublicJwk(candidate.publicKey) &&
    isValidPrivateJwk(candidate.privateKey)
  );
}

function isValidIdentityExport(obj: unknown): obj is IdentityExport {
  if (!obj || typeof obj !== "object") return false;

  const candidate = obj as Record<string, unknown>;

  return (
    candidate.version === 1 &&
    typeof candidate.keyId === "string" &&
    candidate.keyId.length === 64 &&
    (candidate.displayName === undefined || typeof candidate.displayName === "string") &&
    typeof candidate.exportedAt === "number" &&
    isValidPublicJwk(candidate.publicKey) &&
    isValidPrivateJwk(candidate.privateKey)
  );
}

function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalJson).join(",")}]`;
  }
  const record = obj as Record<string, unknown>;
  const sorted = Object.keys(record)
    .filter(k => record[k] !== undefined)
    .sort();
  return `{${sorted.map(k => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}
