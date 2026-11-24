import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson, generateToken, hmacSha256Hex, sha256Hex, timingSafeEqual, toBase64, TOKEN_RE } from "../src/crypto";
import { checkUpload, readPngInfo } from "../src/files";
import { verifyStripeSignature } from "../src/stripe";
import { checkGithubAccount } from "../src/github";
import { fakePng } from "./fakes";

const KEY = toBase64(new Uint8Array(32).map((_, i) => i + 1));

describe("link tokens", () => {
  it("are 256-bit random, URL-safe, and never repeat", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(TOKEN_RE);
    expect(a).not.toBe(b);
  });
  it("are stored as SHA-256", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("compare in constant time", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("AES-GCM secrets", () => {
  it("round-trips", async () => {
    const blob = await encryptJson({ STRIPE_SECRET_KEY: "sk_live_123" }, KEY, "ZP-1");
    expect(blob.ciphertext).not.toContain("sk_live");
    expect(await decryptJson(blob, KEY, "ZP-1")).toEqual({ STRIPE_SECRET_KEY: "sk_live_123" });
  });
  it("uses a new IV every time", async () => {
    const a = await encryptJson({ a: 1 }, KEY, "ZP-1");
    const b = await encryptJson({ a: 1 }, KEY, "ZP-1");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
  it("won't decrypt on another project's row", async () => {
    const blob = await encryptJson({ a: 1 }, KEY, "ZP-1");
    await expect(decryptJson(blob, KEY, "ZP-2")).rejects.toThrow();
  });
  it("refuses a key that isn't 32 bytes", async () => {
    await expect(encryptJson({}, toBase64(new Uint8Array(16)), "x")).rejects.toThrow(/32 bytes/);
  });
});

describe("Stripe webhook signature", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
  const now = 1_800_000_000;

  it("accepts a correctly signed, fresh event", async () => {
    const sig = await hmacSha256Hex(secret, `${now}.${body}`);
    expect(await verifyStripeSignature(body, `t=${now},v1=${sig}`, secret, now)).toBe(true);
    expect(await verifyStripeSignature(body, `t=${now},v1=deadbeef,v1=${sig}`, secret, now)).toBe(true);
  });
  it("rejects a changed body, wrong secret, missing header, or old timestamp", async () => {
    const sig = await hmacSha256Hex(secret, `${now}.${body}`);
    expect(await verifyStripeSignature(body + " ", `t=${now},v1=${sig}`, secret, now)).toBe(false);
    expect(await verifyStripeSignature(body, `t=${now},v1=${sig}`, "whsec_other", now)).toBe(false);
    expect(await verifyStripeSignature(body, null, secret, now)).toBe(false);
    expect(await verifyStripeSignature(body, `t=${now},v1=${sig}`, secret, now + 301)).toBe(false);
    expect(await verifyStripeSignature(body, `t=${now},v1=${sig}`, "", now)).toBe(false);
  });
});

describe("logo checks", () => {
  it("reads PNG size and transparency", () => {
    expect(readPngInfo(fakePng(1200, 6))).toEqual({ width: 1200, height: 400, hasAlpha: true });
    expect(readPngInfo(fakePng(1200, 2))?.hasAlpha).toBe(false);
    expect(readPngInfo(fakePng(1200, 2, true))?.hasAlpha).toBe(true);
  });
  it("accepts a wide transparent PNG, rejects narrow or solid ones", () => {
    expect(checkUpload("logo", fakePng(1200, 6)).ok).toBe(true);
    const narrow = checkUpload("logo", fakePng(800, 6));
    expect(narrow.ok === false && narrow.error).toMatch(/800px/);
    const solid = checkUpload("logo", fakePng(1200, 2));
    expect(solid.ok === false && solid.error).toMatch(/transparent/);
  });
  it("accepts clean SVG and EPS, rejects SVG with scripts", () => {
    const enc = new TextEncoder();
    expect(checkUpload("logo", enc.encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')).ok).toBe(true);
    expect(checkUpload("logo", enc.encode("%!PS-Adobe-3.0 EPSF-3.0")).ok).toBe(true);
    expect(checkUpload("logo", enc.encode('<svg onload="alert(1)"></svg>')).ok).toBe(false);
    expect(checkUpload("logo", enc.encode("<svg><script>x</script></svg>")).ok).toBe(false);
  });
  it("JPG is fine as an extra brand file but not as the logo", () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect(checkUpload("logo", jpg).ok).toBe(false);
    expect(checkUpload("asset", jpg).ok).toBe(true);
    expect(checkUpload("asset", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])).ok).toBe(true);
    expect(checkUpload("asset", new TextEncoder().encode("MZ fake exe")).ok).toBe(false);
  });
});

describe("GitHub account check", () => {
  const fake = (status: number, body: unknown = {}) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("asks GitHub and reports what it says", async () => {
    expect(await checkGithubAccount("acme", undefined, fake(200, { login: "Acme", type: "Organization" }))).toEqual({
      status: "exists",
      type: "Organization",
      login: "Acme",
    });
    expect((await checkGithubAccount("ghost-user-x", undefined, fake(404))).status).toBe("not_found");
    expect((await checkGithubAccount("acme", undefined, fake(403))).status).toBe("unverified");
  });
  it("never calls GitHub for a malformed name", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect((await checkGithubAccount("-bad-", undefined, spy)).status).toBe("invalid");
    expect(called).toBe(false);
  });
});
