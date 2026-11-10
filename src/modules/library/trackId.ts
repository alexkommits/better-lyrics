/**
 * Stable track identity for the standalone app (STANDALONE-WEB-PLAN.md §4.2/§6.7):
 *
 *   trackId = sha1(normalized rel path)[:12] + "-" + sha1(fingerprint)[:16]
 *
 * where the fingerprint hashes the file size plus the first and last 512 KB of content. Both the
 * library scanner (node) and the in-browser drop path compute the same values, so a track keeps
 * its identity across rebuilds and across machines with the same library layout.
 *
 * This module uses only Web Crypto (available in browsers and node ≥ 20) and stays I/O free —
 * callers supply the bytes.
 */

const HEAD_BYTES = 512 * 1024;
const PATH_HASH_LEN = 12;
const FINGERPRINT_LEN = 16;

/** Lowercases, converts backslashes, strips leading "./", collapses separators. */
function normalizeRelPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .toLowerCase()
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .trim();
}

/**
 * Builds the fingerprint sample: 8 bytes of size (big endian) + first 512 KB + last 512 KB.
 * Files smaller than 1 MB are sampled exactly once (no overlap).
 */
function fingerprintSample(bytes: Uint8Array): Uint8Array {
  const size = bytes.byteLength;
  const head = bytes.subarray(0, Math.min(size, HEAD_BYTES));
  const tailStart = Math.max(head.byteLength, size - HEAD_BYTES);
  const tail = bytes.subarray(tailStart);

  const sample = new Uint8Array(8 + head.byteLength + tail.byteLength);
  new DataView(sample.buffer).setBigUint64(0, BigInt(size), false);
  sample.set(head, 8);
  sample.set(tail, 8 + head.byteLength);
  return sample;
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", bytes as BufferSource);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Text encoder reused for path hashing. */
const encoder = new TextEncoder();

/** Computes the stable track id for a file given its path and full contents. */
export async function trackIdFor(normalizedRelPath: string, bytes: Uint8Array): Promise<string> {
  const pathHash = (await sha1Hex(encoder.encode(normalizeRelPath(normalizedRelPath)))).slice(0, PATH_HASH_LEN);
  const fingerprint = (await sha1Hex(fingerprintSample(bytes))).slice(0, FINGERPRINT_LEN);
  return `${pathHash}-${fingerprint}`;
}
