import { describe, expect, it } from "vitest";
import { buildIntakeSchema, flattenIssues, isValidGithubName } from "@zinkpress/shared";

export function validTier1() {
  return {
    registrarProvider: "Namecheap",
    registrarDelegatedConfirmed: true,
    cloudflareAdminConfirmed: true,
    githubTarget: "acme-studio",
    logoKey: "ZP-001/assets/logo-abc.svg",
    primaryHex: "#0F172A",
    secondaryHex: "#22d3ee",
    font: { mode: "system" },
    copy: { mode: "link", url: "https://docs.google.com/document/d/abc/edit" },
    copyFinalizedConfirmed: true,
    secrets: {},
    adminEmails: [],
    spocName: "Jordan Lee",
    spocEmail: "jordan@acme.com",
  };
}

const t1 = buildIntakeSchema({ tier: "TIER_1", requiredIntegrations: [] });
const t2 = buildIntakeSchema({ tier: "TIER_2", requiredIntegrations: ["STRIPE_SECRET_KEY"] });

function errorsOf(schema: typeof t1, data: unknown) {
  const r = schema.safeParse(data);
  return r.success ? {} : flattenIssues(r.error.issues);
}

describe("intake schema", () => {
  it("accepts a complete Tier 1 intake", () => {
    expect(t1.safeParse(validTier1()).success).toBe(true);
  });

  it("requires every confirmation checkbox to be ticked", () => {
    const e = errorsOf(t1, { ...validTier1(), registrarDelegatedConfirmed: false, copyFinalizedConfirmed: false });
    expect(e.registrarDelegatedConfirmed).toMatch(/registrar/);
    expect(e.copyFinalizedConfirmed).toMatch(/final/);
  });

  it("rejects bad hex colors", () => {
    expect(errorsOf(t1, { ...validTier1(), primaryHex: "blue" }).primaryHex).toBeTruthy();
    expect(errorsOf(t1, { ...validTier1(), secondaryHex: "#FFF" }).secondaryHex).toBeTruthy();
  });

  it("rejects GitHub names GitHub itself wouldn't allow", () => {
    for (const bad of ["-acme", "acme-", "ac--me", "a".repeat(40), "has space", "x_y"]) {
      expect(isValidGithubName(bad), bad).toBe(false);
      expect(errorsOf(t1, { ...validTier1(), githubTarget: bad }).githubTarget, bad).toBeTruthy();
    }
    for (const ok of ["a", "Acme-Studio", "cocodreamz87"]) expect(isValidGithubName(ok), ok).toBe(true);
  });

  it("copy link must be https", () => {
    const e = errorsOf(t1, { ...validTier1(), copy: { mode: "link", url: "http://example.com/doc" } });
    expect(e["copy.url"]).toBeTruthy();
  });

  it("typed copy needs exactly 3 services and no placeholder text", () => {
    const base = { mode: "fields", heroHeadline: "Fresh cuts in Marietta", subheadline: "Walk-ins welcome", contactInfo: "555-0100" };
    expect(t1.safeParse({ ...validTier1(), copy: { ...base, services: ["Fades", "Beards", "Kids cuts"] } }).success).toBe(true);
    expect(errorsOf(t1, { ...validTier1(), copy: { ...base, services: ["Fades", "Beards"] } })["copy.services"]).toBeTruthy();
    const e = errorsOf(t1, { ...validTier1(), copy: { ...base, heroHeadline: "Lorem ipsum dolor", services: ["A1", "B1", "TBD"] } });
    expect(e["copy.heroHeadline"]).toMatch(/placeholder/);
    expect(e["copy.services.2"]).toMatch(/placeholder/);
  });

  it("Tier 1 refuses API keys", () => {
    expect(errorsOf(t1, { ...validTier1(), secrets: { STRIPE_SECRET_KEY: "sk_test_1" } }).secrets).toBeTruthy();
  });

  it("Tier 2 needs the contracted keys and an admin email", () => {
    const e = errorsOf(t2, validTier1());
    expect(e["secrets.STRIPE_SECRET_KEY"]).toMatch(/required/);
    expect(e.adminEmails).toBeTruthy();
    const ok = {
      ...validTier1(),
      secrets: { STRIPE_SECRET_KEY: "sk_test_123" },
      adminEmails: ["owner@acme.com"],
      legalBusinessName: "Acme Studio LLC",
      einOrRegistration: "12-3456789",
    };
    expect(t2.safeParse(ok).success).toBe(true);
  });

  it("Tier 2 needs the legal business name and an EIN or registration number; Tier 1 doesn't", () => {
    const e = errorsOf(t2, { ...validTier1(), secrets: { STRIPE_SECRET_KEY: "sk" }, adminEmails: ["a@acme.com"] });
    expect(e.legalBusinessName).toMatch(/legal name/);
    expect(e.einOrRegistration).toMatch(/EIN/);
    expect(t1.safeParse(validTier1()).success).toBe(true);
    // Optional on Tier 1, but if given it must look like an EIN or registration number.
    expect(errorsOf(t1, { ...validTier1(), einOrRegistration: "!!" }).einOrRegistration).toBeTruthy();
    expect(t1.safeParse({ ...validTier1(), einOrRegistration: "123456789" }).success).toBe(true);
  });

  it("Tier 2 approver can't use a free mailbox unless the email rule is overridden", () => {
    const base = {
      ...validTier1(),
      secrets: { STRIPE_SECRET_KEY: "sk" },
      adminEmails: ["a@acme.com"],
      legalBusinessName: "Acme Studio LLC",
      einOrRegistration: "12-3456789",
    };
    for (const mail of ["jo@gmail.com", "jo@YAHOO.com", "jo@hotmail.com", "jo@outlook.com", "jo@icloud.com"]) {
      expect(errorsOf(t2, { ...base, spocEmail: mail }).spocEmail, mail).toMatch(/company/);
    }
    const overridden = buildIntakeSchema({ tier: "TIER_2", requiredIntegrations: ["STRIPE_SECRET_KEY"], companyEmailRequired: false });
    expect(overridden.safeParse({ ...base, spocEmail: "jo@gmail.com" }).success).toBe(true);
    expect(t1.safeParse({ ...validTier1(), spocEmail: "jo@gmail.com" }).success).toBe(true);
  });

  it("a Tier 1 at $2,500 or more gets the business check too", async () => {
    const { needsBusinessCheck } = await import("@zinkpress/shared");
    expect(needsBusinessCheck("TIER_1", 249_999)).toBe(false);
    expect(needsBusinessCheck("TIER_1", 250_000)).toBe(true);
    expect(needsBusinessCheck("TIER_2", null)).toBe(true);
    const big = buildIntakeSchema({ tier: "TIER_1", requiredIntegrations: [], businessCheckRequired: needsBusinessCheck("TIER_1", 300_000) });
    expect(errorsOf(big, validTier1()).legalBusinessName).toBeTruthy();
  });

  it("key names must be CAPITAL_SNAKE_CASE (no free-form JSON blob)", () => {
    const bad = { ...validTier1(), secrets: { STRIPE_SECRET_KEY: "sk", "lower-case": "x" }, adminEmails: ["a@b.co"] };
    expect(t2.safeParse(bad).success).toBe(false);
  });

  it("registrar must be picked", () => {
    expect(errorsOf(t1, { ...validTier1(), registrarProvider: undefined }).registrarProvider).toBe("Pick your domain registrar.");
  });

  it("approver needs a real email", () => {
    expect(errorsOf(t1, { ...validTier1(), spocEmail: "jordan@" }).spocEmail).toBeTruthy();
  });
});
