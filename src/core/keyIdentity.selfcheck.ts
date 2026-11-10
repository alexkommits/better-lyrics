import assert from "node:assert/strict";

// localStorage is the storage adapter's backend; this mock implements the DOMStorage contract
// the adapter uses (length/key/getItem/setItem/removeItem) over an in-memory map.
const local = new Map<string, string>();
const heldGenerateKey: { release?: () => void } = {};
const heldDigest: { release?: () => void } = {};
let armDigestHold = false;

const localStorageMock = {
  get length() {
    return local.size;
  },
  key(index: number): string | null {
    return [...local.keys()][index] ?? null;
  },
  getItem(key: string): string | null {
    return local.has(key) ? local.get(key)! : null;
  },
  setItem(key: string, value: string): void {
    local.set(key, String(value));
  },
  removeItem(key: string): void {
    local.delete(key);
  },
  clear(): void {
    local.clear();
  },
};

Object.assign(globalThis, { localStorage: localStorageMock });

// crypto.subtle.generateKey is where a fresh identity is born; holding the first call lets an
// import land while a generation is in flight, deterministically.
const subtle = crypto.subtle;
const originalGenerateKey = subtle.generateKey.bind(subtle);
let armGenerateKeyHold = false;
subtle.generateKey = ((...args: Parameters<typeof subtle.generateKey>) => {
  if (armGenerateKeyHold) {
    armGenerateKeyHold = false;
    return new Promise<CryptoKeyPair>(resolve => {
      heldGenerateKey.release = () => resolve(originalGenerateKey(...args) as Promise<CryptoKeyPair>);
    });
  }
  return originalGenerateKey(...args);
}) as typeof subtle.generateKey;

// subtle.digest is the first await inside importIdentity; holding the second import's digest
// lets the first import commit before the second queues, so call order decides commit order.
const originalDigest = subtle.digest.bind(subtle);
subtle.digest = ((...args: Parameters<typeof subtle.digest>) => {
  if (armDigestHold) {
    armDigestHold = false;
    return new Promise<ArrayBuffer>(resolve => {
      heldDigest.release = () => resolve(originalDigest(...args));
    });
  }
  return originalDigest(...args);
}) as typeof subtle.digest;

const storedKeyId = (): unknown => {
  const raw = local.get("userIdentity");
  if (!raw) return undefined;
  try {
    return (JSON.parse(raw) as { keyId?: unknown }).keyId;
  } catch {
    return undefined;
  }
};

const { forgetDisplayName, generatePetName, getIdentity, getLastKnownDisplayName, importIdentity } = await import(
  "@core/keyIdentity"
);

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
const waitFor = async (condition: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${label}`);
};

async function exportFixture(): Promise<{ json: string; keyId: string }> {
  const params = { name: "ECDSA", namedCurve: "P-256" };
  const pair = await crypto.subtle.generateKey(params, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const canonical = JSON.stringify({ crv: publicKey.crv, kty: publicKey.kty, x: publicKey.x, y: publicKey.y });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const keyId = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return { json: JSON.stringify({ version: 1, keyId, publicKey, privateKey, exportedAt: Date.now() }), keyId };
}

// -- Regressions --------------------------
{
  const fixture = await exportFixture();
  armGenerateKeyHold = true;
  const pending = getIdentity();
  await waitFor(() => heldGenerateKey.release !== undefined, "the generation to reach key generation");

  const imported = await importIdentity(fixture.json);
  assert.equal(imported.keyId, fixture.keyId, "the import returns the imported identity");
  assert.equal(storedKeyId(), fixture.keyId, "the import is stored");

  heldGenerateKey.release?.();
  const settled = await pending;
  assert.equal(settled.keyId, fixture.keyId, "regression: a pending generation resolves to the imported identity");
  assert.equal(storedKeyId(), fixture.keyId, "regression: a pending generation never overwrites an import");
  assert.equal((await getIdentity()).keyId, fixture.keyId, "later reads keep the imported identity");
}

// -- Nickname reset --------------------------
{
  const { keyId } = await getIdentity();
  localStorage.setItem("identityDisplayName", JSON.stringify({ keyId, displayName: "OldNickname" }));
  assert.equal(await getLastKnownDisplayName(), "OldNickname", "the remembered nickname is used offline");
  await forgetDisplayName();
  assert.equal(localStorage.getItem("identityDisplayName"), null, "a reset forgets the remembered nickname");
  assert.equal(
    await getLastKnownDisplayName(),
    generatePetName(keyId),
    "after a reset the offline name is the pet name"
  );
}

// -- Import replaces --------------------------
{
  const next = await exportFixture();
  await importIdentity(next.json);
  assert.equal((await getIdentity()).keyId, next.keyId, "a second import replaces the cached identity");
  assert.equal(storedKeyId(), next.keyId, "a second import replaces the stored identity");
  await assert.rejects(importIdentity("{"), /Invalid JSON/, "malformed JSON is rejected");
  assert.equal((await getIdentity()).keyId, next.keyId, "a rejected import leaves the identity alone");
}

// -- Overlapping imports --------------------------
{
  const first = await exportFixture();
  const second = await exportFixture();
  // The first import's digest has already started when this arms, so the arm is consumed by
  // the second import's digest: the first commits before the second even reaches the queue.
  const firstImport = importIdentity(first.json);
  armDigestHold = true;
  const secondImport = importIdentity(second.json);
  await waitFor(() => heldDigest.release !== undefined, "the second import to reach hashing");
  await firstImport;
  heldDigest.release?.();
  await secondImport;

  assert.equal(storedKeyId(), second.keyId, "regression: the last import wins in storage");
  assert.equal((await getIdentity()).keyId, second.keyId, "regression: the cache matches the stored identity");
}

console.log("keyIdentity self-check passed");
