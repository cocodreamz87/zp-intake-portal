#!/usr/bin/env node
/**
 * Shows one project's client API keys on YOUR computer only.
 *
 * Usage (from apps/worker):
 *   SECRETS_ENCRYPTION_KEY="the same value you gave wrangler" node scripts/reveal-secrets.mjs ZP-2026-014
 * Add --local to read your local dev database instead of the live one.
 *
 * It asks wrangler for the encrypted blob, then decrypts it here. The key never leaves your machine.
 */
import { execFileSync } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";

const args = process.argv.slice(2);
const projectId = args.find((a) => !a.startsWith("--"));
const where = args.includes("--local") ? "--local" : "--remote";
const keyB64 = process.env.SECRETS_ENCRYPTION_KEY;

if (!projectId || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(projectId)) {
  console.error("Usage: SECRETS_ENCRYPTION_KEY=... node scripts/reveal-secrets.mjs PROJECT_ID [--local]");
  process.exit(1);
}
if (!keyB64) {
  console.error("Set SECRETS_ENCRYPTION_KEY first (the value you stored with `wrangler secret put`).");
  process.exit(1);
}

const out = execFileSync(
  "npx",
  [
    "wrangler", "d1", "execute", "zp-intake", where, "--json",
    "--command",
    `SELECT encrypted_secrets_blob AS c, secrets_iv AS iv, secrets_purged_at AS purged FROM onboarding_sessions WHERE project_id = '${projectId}'`,
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

const key = await crypto.subtle.importKey("raw", Buffer.from(keyB64, "base64"), { name: "AES-GCM" }, false, ["decrypt"]);
const plain = await crypto.subtle.decrypt(
  { name: "AES-GCM", iv: Buffer.from(row.iv, "base64"), additionalData: new TextEncoder().encode(projectId) },
  key,
  Buffer.from(row.c, "base64"),
);
console.log(JSON.parse(new TextDecoder().decode(plain)));
