/**
 * Small Web Crypto helpers. Everything here runs on Cloudflare Workers and Node 22.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The link token a client gets in their email.
 * 32 random bytes = 256 bits, so it can't be guessed. Only its SHA-256 hash is
 * stored in D1, so a leaked database backup can't be turned into working links.
 */
export function generateToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

/** Compares two strings without leaking where they differ through timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/**
 * SECRETS_ENCRYPTION_KEY can be either:
 *  - exactly 32 bytes written as base64 (what `openssl rand -base64 32` prints), used as-is, or
 *  - any random password of 32+ characters (easy to make in a password manager),
 *    turned into a 32-byte key with SHA-256.
 * Either way, changing it later makes keys already stored unreadable.
 */
export async function aesKeyBytes(secret: string): Promise<Uint8Array> {
  const s = secret.trim();
  if (/^[A-Za-z0-9+/]{43}=$/.test(s)) {
    const raw = fromBase64(s);
    if (raw.length === 32) return raw;
  }
  if (s.length < 32) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be a random password of at least 32 characters");
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

async function importAesKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await aesKeyBytes(secret), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export interface EncryptedBlob {
  ciphertext: string; // base64
  iv: string; // base64, 12 bytes, new for every encryption
}

/**
 * AES-256-GCM. `context` (we use the project id) is bound in as "additional data",
 * so a blob copied onto another project's row will refuse to decrypt.
 */
export async function encryptJson(value: unknown, base64Key: string, context: string): Promise<EncryptedBlob> {
  const key = await importAesKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(context) },
    key,
    enc.encode(JSON.stringify(value)),
  );
  return { ciphertext: toBase64(new Uint8Array(ct)), iv: toBase64(iv) };
}

export async function decryptJson<T = unknown>(blob: EncryptedBlob, base64Key: string, context: string): Promise<T> {
  const key = await importAesKey(base64Key);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(blob.iv), additionalData: enc.encode(context) },
    key,
    fromBase64(blob.ciphertext),
  );
  return JSON.parse(dec.decode(pt)) as T;
}
