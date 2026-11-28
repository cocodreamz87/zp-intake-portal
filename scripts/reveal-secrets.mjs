#!/usr/bin/env node
/**
 * Shows one project's client API keys on YOUR computer only.
 *
 * Usage (from the repo's top folder):
 *   SECRETS_ENCRYPTION_KEY="the same value you saved in Cloudflare" node scripts/reveal-secrets.mjs ZP-2026-014
 * Add --local to read your local dev database instead of the live one.
 * Add --maintenance to read the keys the client re-entered on their newest re-auth link instead.
 *
 * It asks wrangler for the encrypted blob, then decrypts it here. The key never leaves your machine.
 */
import { execFileSync } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";

const args = process.argv.slice(2);
const projectId = args.find((a) => !a.startsWith("--"));
const where = args.includes("--local") ? "--local" : "--remote";
const maintenance = args.includes("--maintenance");
const keyB64 = process.env.SECRETS_ENCRYPTION_KEY;

if (!projectId || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(projectId)) {
  console.error("Usage: SECRETS_ENCRYPTION_KEY=... node scripts/reveal-secrets.mjs PROJECT_ID [--local]");
  process.exit(1);
}
if (!keyB64) {
  console.error("Set SECRETS_ENCRYPTION_KEY first (the same value you saved in Cloudflare).");
  process.exit(1);
}

const out = execFileSync(
  "npx",
  [
    "wrangler", "d1", "execute", "zp-intake", where, "--json",
    "--command",
    maintenance
      ? `SELECT encrypted_secrets_blob AS c, secrets_iv AS iv, secrets_purged_at AS purged FROM maintenance_requests WHERE project_id = '${projectId}' AND submitted_at IS NOT NULL ORDER BY submitted_at DESC LIMIT 1`
      : `SELECT encrypted_secrets_blob AS c, secrets_iv AS iv, secrets_purged_at AS purged FROM onboarding_sessions WHERE project_id = '${projectId}'`,
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
const row = JSON.parse(out)?.[0]?.results?.[0];
if (!row) {
  console.error(`No project called ${projectId}.`);
  process.exit(1);
}
if (!row.c) {
  console.log(row.purged ? `Keys for ${projectId} were purged on ${row.purged}.` : `${projectId} has no stored keys.`);
  process.exit(0);
}

// Same rule as apps/worker/src/crypto.ts: 32-byte base64 is used as-is, anything else goes through SHA-256.
const secret = keyB64.trim();
let keyBytes = /^[A-Za-z0-9+/]{43}=$/.test(secret) ? Buffer.from(secret, "base64") : null;
if (!keyBytes || keyBytes.length !== 32) {
  keyBytes = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
}
const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
const plain = await crypto.subtle.decrypt(
  { name: "AES-GCM", iv: Buffer.from(row.iv, "base64"), additionalData: new TextEncoder().encode(projectId) },
  key,
  Buffer.from(row.c, "base64"),
);
console.log(JSON.parse(new TextDecoder().decode(plain)));
