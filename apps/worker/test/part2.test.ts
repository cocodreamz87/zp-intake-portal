/**
 * Part 2: client status page, re-auth (maintenance) links, 50% / 100% sprint emails,
 * testimonials, and invoices made from a HubSpot scoping deal. Every outside call is faked.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { app, setOutboundFetch } from "../src/index";
import { decryptJson, hmacSha256Hex, toBase64 } from "../src/crypto";
import { runScheduled } from "../src/followups";
import { runMilestones } from "../src/milestones";
import { halfwayDay, sprintProgress } from "../src/schedule";
import type { Env } from "../src/env";
import { fakeD1, fakePng, fakeR2 } from "./fakes";

const ENC_KEY = toBase64(new Uint8Array(32).map((_, i) => 50 + i));
const ADMIN = "c".repeat(40);
const WHSEC = "whsec_unit_test";
const HOOK = (n: string) => `https://hooks.slack.com/services/T000/B000/${n}`;
const TZ = "America/New_York";

let env: Env;
let pending: Promise<unknown>[];
let emails: Array<{ to: string[]; subject: string; text: string; key: string | null }>;
let slack: Array<{ url: string; body: any }>;
let stripeCalls: Array<{ method: string; path: string; body: URLSearchParams | null }>;
let hubspot: Array<{ method: string; path: string; body: any }>;
let fakeFetch: typeof fetch;

const ctx = () =>
  ({ waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;

async function settle() {
  while (pending.length) await Promise.all(pending.splice(0));
}

async function req(path: string, init: RequestInit = {}) {
  const res = await app.fetch(new Request(`https://api.test${path}`, init), env, ctx());
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  await settle();
  return { status: res.status, json, headers: res.headers };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const admin = { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" };
const json = (t: string) => ({ ...auth(t), "Content-Type": "application/json" });
const posts = (n: string) => slack.filter((p) => p.url === HOOK(n));

async function stripe(event: unknown) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = await hmacSha256Hex(WHSEC, `${t}.${body}`);
  return req("/api/stripe/webhook", { method: "POST", body, headers: { "Stripe-Signature": `t=${t},v1=${sig}` } });
}

function invoice(over: { tier?: string; project?: string; deal?: string } = {}) {
  return {
    id: `evt_${over.project ?? "1"}`,
    type: "invoice.paid",
    data: {
      object: {
        id: `in_${over.project ?? "1"}`,
        customer_email: "owner@acme.com",
        customer_name: "Acme Barbers",
        amount_paid: 30000, // under $500, so no rail check
        currency: "usd",
        metadata: {
          project_id: over.project ?? "ZP-2026-040",
          tier: over.tier ?? "TIER_2",
          company_name: "Acme Barbers",
          contact_name: "Jordan Lee",
          integrations: "STRIPE_SECRET_KEY",
          ...(over.deal ? { hubspot_deal_id: over.deal } : {}),
        },
      },
    },
  };
}

function tokenFrom(text: string, page = "") {
  const m = new RegExp(`${page}\\?token=([A-Za-z0-9_-]{43})`).exec(text);
  if (!m) throw new Error(`no ${page || "intake"} token in: ${text.slice(0, 200)}`);
  return m[1];
}

async function row(projectId = "ZP-2026-040") {
  return env.DB.prepare("SELECT * FROM onboarding_sessions WHERE project_id = ?").bind(projectId).first<any>();
}

async function events() {
  return ((await env.DB.prepare("SELECT event, detail FROM audit_log ORDER BY id").all<{ event: string; detail: string }>()).results ?? []).map(
    (e) => e.event,
  );
}

async function submit(t: string) {
  const fd = new FormData();
  fd.append("file", new File([fakePng(1600, 6)], "logo.png", { type: "image/png" }));
  fd.append("kind", "logo");
  const up = await req("/api/assets/upload", { method: "POST", body: fd, headers: auth(t) });
  return req("/api/onboarding/submit", {
    method: "POST",
    headers: json(t),
    body: JSON.stringify({
      registrarProvider: "Cloudflare",
      registrarDelegatedConfirmed: true,
      cloudflareAdminConfirmed: true,
      githubTarget: "acme-barbers",
      legalBusinessName: "Acme Barbers LLC",
      einOrRegistration: "12-3456789",
      logoKey: up.json.key,
      primaryHex: "#B91C1C",
      secondaryHex: "#111111",
      font: { mode: "system" },
      copy: { mode: "link", url: "https://www.notion.so/acme/final-copy" },
      copyFinalizedConfirmed: true,
      secrets: { STRIPE_SECRET_KEY: "sk_test_clientkey123" },
      adminEmails: ["owner@acme.com"],
      spocName: "Jordan Lee",
      spocEmail: "jordan@acme.com",
    }),
  });
}

/** Paid, submitted project. Returns the client's intake token. */
async function runningProject(tier = "TIER_2", project = "ZP-2026-040") {
  await stripe(invoice({ tier, project }));
  const t = tokenFrom(emails.at(-1)!.text);
  expect((await submit(t)).status).toBe(200);
  return t;
}

/** Moves a project's saved clock so "now" lands where a test needs it. */
async function setClock(startIso: string, deadlineIso: string, project = "ZP-2026-040") {
  await env.DB.prepare("UPDATE onboarding_sessions SET clock_started_at = ?, guaranteed_deadline = ? WHERE project_id = ?")
    .bind(startIso, deadlineIso, project)
    .run();
}

async function launch(project = "ZP-2026-040", launchedAt = new Date().toISOString()) {
  await req(`/api/admin/sessions/${project}/launched`, { method: "POST", headers: admin });
  await env.DB.prepare("UPDATE onboarding_sessions SET launched_at = ? WHERE project_id = ?").bind(launchedAt, project).run();
}

beforeEach(() => {
  pending = [];
  emails = [];
  slack = [];
  stripeCalls = [];
  hubspot = [];
  env = {
    DB: fakeD1(),
    ASSETS_BUCKET: fakeR2().bucket,
    AGENCY_NAME: "ZinkPress",
    AGENCY_EMAIL: "ZinkPress@proton.me",
    PORTAL_URL: "",
    BUSINESS_TIMEZONE: TZ,
    HOLIDAYS: "",
    RECEIPT_FROM_EMAIL: "hello@zinkpress.test",
    RESEND_API_KEY: "re_test",
    STRIPE_WEBHOOK_SECRET: WHSEC,
    SECRETS_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_API_TOKEN: ADMIN,
    STRIPE_SECRET_KEY: "rk_test_unitkey000000",
    HUBSPOT_ACCESS_TOKEN: "pat-test",
    SLACK_WEBHOOK_SPRINT_OPS: HOOK("sprint"),
    SLACK_WEBHOOK_ERRORS: HOOK("errors"),
  } as Env;

  fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method || "GET").toUpperCase();
    if (url.hostname === "api.resend.com") {
      const b = JSON.parse(String(init.body));
      emails.push({ to: b.to, subject: b.subject, text: b.text, key: new Headers(init.headers).get("Idempotency-Key") });
      return Response.json({ id: `email_${emails.length}` });
    }
    if (url.hostname === "api.github.com") return Response.json({ login: "acme-barbers", type: "Organization" });
    if (url.hostname === "hooks.slack.com") {
      slack.push({ url: url.href, body: JSON.parse(String(init.body)) });
      return new Response("ok");
    }
    if (url.hostname === "api.hubapi.com") {
      hubspot.push({ method, path: url.pathname + url.search, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.pathname === "/crm/v3/objects/deals/404") return new Response('{"message":"not found"}', { status: 404 });
      if (url.pathname.startsWith("/crm/v3/objects/deals/") && method === "GET") {
        return Response.json({
          id: url.pathname.split("/").pop(),
          properties: { dealname: "Alex Rivera — ZinkPress scoping (Tier 2)" },
          associations: { contacts: { results: [{ id: "c1" }] }, companies: { results: [{ id: "co1" }] } },
        });
      }
      if (url.pathname === "/crm/v3/objects/contacts/c1") {
        return Response.json({ id: "c1", properties: { email: "Alex@RiverCo.com", firstname: "Alex", lastname: "Rivera" } });
      }
      if (url.pathname === "/crm/v3/objects/companies/co1") return Response.json({ id: "co1", properties: { name: "River Co" } });
      if (method === "PATCH") return Response.json({ id: "ok" });
      return new Response("not faked", { status: 404 });
    }
    if (url.hostname === "api.stripe.com") {
      const body = init.body ? new URLSearchParams(String(init.body)) : null;
      stripeCalls.push({ method, path: url.pathname + url.search, body });
      if (url.pathname === "/v1/customers" && method === "GET") return Response.json({ data: [] });
      if (url.pathname === "/v1/customers") return Response.json({ id: "cus_1" });
      if (url.pathname === "/v1/invoices") return Response.json({ id: "in_new" });
      if (url.pathname === "/v1/invoiceitems") return Response.json({ id: "ii_1" });
      if (url.pathname.endsWith("/finalize")) return Response.json({ id: "in_new", status: "open", hosted_invoice_url: "https://invoice.stripe.com/i/test" });
      if (url.pathname.endsWith("/send")) return Response.json({ id: "in_new", status: "open", hosted_invoice_url: "https://invoice.stripe.com/i/test" });
      return new Response("not faked", { status: 404 });
    }
    throw new Error(`unexpected outbound call in test: ${method} ${url.href}`);
  }) as typeof fetch;
  setOutboundFetch(fakeFetch);
});

/* ------------------------------------------------------------------ */

describe("sprint progress (business days)", () => {
  // Monday Dec 7 2026, 9:00 AM Eastern kickoff; Tier 2 = 10 business days -> Monday Dec 21 9:00 AM.
  const start = "2026-12-07T14:00:00.000Z";
  const end = "2026-12-21T14:00:00.000Z";

  it("counts a day once its 9:00 AM boundary passes, and skips weekends", () => {
    expect(sprintProgress(start, end, new Date("2026-12-07T15:00:00Z"), { timeZone: TZ })).toMatchObject({
      businessDaysTotal: 10,
      businessDaysElapsed: 0,
      started: true,
    });
    // Tuesday 9:00 AM = day 1 done.
    expect(sprintProgress(start, end, new Date("2026-12-08T14:00:00Z"), { timeZone: TZ }).businessDaysElapsed).toBe(1);
    // Saturday: still 4 (Tue, Wed, Thu, Fri).
    expect(sprintProgress(start, end, new Date("2026-12-12T18:00:00Z"), { timeZone: TZ }).businessDaysElapsed).toBe(4);
    // Monday the 14th 9:00 AM = 5 of 10 = 50%.
    const half = sprintProgress(start, end, new Date("2026-12-14T14:00:00Z"), { timeZone: TZ });
    expect(half).toMatchObject({ businessDaysElapsed: 5, percent: 50, deadlineReached: false });
    expect(sprintProgress(start, end, new Date("2026-12-21T14:00:00Z"), { timeZone: TZ })).toMatchObject({
      businessDaysElapsed: 10,
      businessDaysLeft: 0,
      percent: 100,
      deadlineReached: true,
    });
  });

  it("puts the 50% email on day 3 of 5, 5 of 10 and 10 of 20", () => {
    expect([halfwayDay(5), halfwayDay(10), halfwayDay(20)]).toEqual([3, 5, 10]);
  });
});

describe("client status page (GET /api/status)", () => {
  it("shows Intake complete before kickoff and Building after, with no internal fields", async () => {
    const t = await runningProject();
    const future = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const later = new Date(Date.now() + 15 * 86_400_000).toISOString();
    await setClock(future, later);
    let r = await req("/api/status", { headers: auth(t) });
    expect(r.status).toBe(200);
    expect(r.json.stage).toBe("INTAKE_COMPLETE");
    expect(r.json.businessDaysElapsed).toBe(0);
    for (const k of ["secrets", "encrypted_secrets_blob", "token_hash", "ein_or_registration", "spoc_email", "staging_url"]) {
      expect(JSON.stringify(r.json)).not.toContain(k);
    }

    await setClock(new Date(Date.now() - 86_400_000).toISOString(), later);
    r = await req("/api/status", { headers: auth(t) });
    expect(r.json.stage).toBe("BUILDING");
    expect(r.json.percent).toBeGreaterThanOrEqual(0);
    expect(r.json.businessDaysTotal).toBeGreaterThan(0);
  });

  it("follows the project into review and launch on the review link", async () => {
    await runningProject();
    const rv = await req("/api/admin/sessions/ZP-2026-040/ready-for-review", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ stagingUrl: "https://acme.pages.dev", loomUrl: `https://www.loom.com/share/${"a".repeat(32)}`, releaseNotes: "All pages built." }),
    });
    const reviewToken = tokenFrom(rv.json.link, "review");
    let r = await req("/api/status", { headers: auth(reviewToken) });
    expect(r.json).toMatchObject({ stage: "STAGING_REVIEW", percent: 100, businessDaysLeft: 0 });
    await launch();
    r = await req("/api/status", { headers: auth(reviewToken) });
    expect(r.json.stage).toBe("LAUNCHED");
    expect(r.json.launchedAt).toBeTruthy();
  });

  it("rejects a missing or wrong link", async () => {
    expect((await req("/api/status")).status).toBe(401);
    expect((await req("/api/status", { headers: auth("z".repeat(43)) })).status).toBe(401);
  });
});

describe("re-auth (maintenance) links", () => {
  it("only for launched projects, admin only", async () => {
    await runningProject();
    const make = () => req("/api/admin/sessions/ZP-2026-040/maintenance", { method: "POST", headers: admin, body: "{}" });
    expect((await req("/api/admin/sessions/ZP-2026-040/maintenance", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await make()).status).toBe(409);
    await launch();
    expect((await make()).status).toBe(201);
  });

  it("emails a link, encrypts the re-entered keys, and the newest link replaces the old one", async () => {
    await runningProject();
    await launch();
    const first = await req("/api/admin/sessions/ZP-2026-040/maintenance", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ note: "Add a second booking calendar" }),
    });
    expect(first.json.requiredIntegrations).toEqual(["STRIPE_SECRET_KEY"]); // defaults to the intake's keys
    expect(first.json.emailed).toEqual(["jordan@acme.com", "owner@acme.com"]);
    expect(emails.at(-1)!.subject).toMatch(/change request/);
    const oldToken = tokenFrom(first.json.link, "maintenance");

    const second = await req("/api/admin/sessions/ZP-2026-040/maintenance", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ requiredIntegrations: ["RESEND_API_KEY", "bad key"] }),
    });
    expect(second.json.requiredIntegrations).toEqual(["RESEND_API_KEY"]);
    const t = tokenFrom(second.json.link, "maintenance");
    expect((await req("/api/maintenance", { headers: auth(oldToken) })).status).toBe(410);

    // An intake token doesn't open a maintenance page, and the other way round.
    expect((await req("/api/session", { headers: auth(t) })).status).toBe(401);

    const view = await req("/api/maintenance", { headers: auth(t) });
    expect(view.json).toMatchObject({ projectId: "ZP-2026-040", status: "OPEN", requiredIntegrations: ["RESEND_API_KEY"] });

    const missing = await req("/api/maintenance/submit", { method: "POST", headers: json(t), body: JSON.stringify({ secrets: {} }) });
    expect(missing.status).toBe(422);
    expect(missing.json.fields["secrets.RESEND_API_KEY"]).toBeTruthy();

    const ok = await req("/api/maintenance/submit", {
      method: "POST",
      headers: json(t),
      body: JSON.stringify({ secrets: { RESEND_API_KEY: "re_live_value123", EXTRA: "ignored" } }),
    });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("SUBMITTED");
    const m = await env.DB.prepare("SELECT * FROM maintenance_requests WHERE status = 'SUBMITTED'").first<any>();
    expect(m.encrypted_secrets_blob).not.toContain("re_live_value123");
    expect(await decryptJson({ ciphertext: m.encrypted_secrets_blob, iv: m.secrets_iv }, ENC_KEY, "ZP-2026-040")).toEqual({
      RESEND_API_KEY: "re_live_value123",
    });
    // Audit and Slack get key names only.
    const log = await env.DB.prepare("SELECT detail FROM audit_log").all<{ detail: string }>();
    expect(JSON.stringify(log.results)).not.toContain("re_live_value123");
    expect(JSON.stringify(slack)).not.toContain("re_live_value123");
    expect(posts("sprint").some((p) => JSON.stringify(p.body).includes("Keys re-entered"))).toBe(true);

    // A repeat submit changes nothing.
    const again = await req("/api/maintenance/submit", { method: "POST", headers: json(t), body: JSON.stringify({ secrets: { RESEND_API_KEY: "other" } }) });
    expect(again.json.status).toBe("SUBMITTED");
    expect(await decryptJson({ ciphertext: (await env.DB.prepare("SELECT encrypted_secrets_blob AS c FROM maintenance_requests WHERE id = ?").bind(m.id).first<any>()).c, iv: m.secrets_iv }, ENC_KEY, "ZP-2026-040")).toEqual({ RESEND_API_KEY: "re_live_value123" });

    // Done: the purge date moves in to 7 days, and the cron wipes it once due.
    const done = await req(`/api/admin/maintenance/${m.id}/done`, { method: "POST", headers: admin });
    expect(done.json.status).toBe("DONE");
    await env.DB.prepare("UPDATE maintenance_requests SET secrets_purge_after = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), m.id).run();
    const cron = await runScheduled(env, fakeFetch);
    expect(cron.maintenanceKeysPurged).toBe(1);
    const wiped = await env.DB.prepare("SELECT * FROM maintenance_requests WHERE id = ?").bind(m.id).first<any>();
    expect(wiped.encrypted_secrets_blob).toBeNull();
    expect(wiped.secrets_purged_at).toBeTruthy();
  });

  it("makes the link without email when Resend isn't set up", async () => {
    delete env.RESEND_API_KEY;
    await runningProject();
    await launch();
    const r = await req("/api/admin/sessions/ZP-2026-040/maintenance", { method: "POST", headers: admin, body: "{}" });
    expect(r.status).toBe(201);
    expect(r.json.emailed).toEqual([]);
    expect(emails).toHaveLength(0);
  });
});

describe("50% and 100% sprint emails", () => {
  const now = new Date("2026-12-14T15:00:00Z"); // Monday the 14th, 10 AM Eastern: day 5 of 10 is done

  it("sends the 50% email once, at the halfway day", async () => {
    await runningProject();
    await setClock("2026-12-07T14:00:00.000Z", "2026-12-21T14:00:00.000Z");
    emails = [];
    // The day before: 4 of 10, nothing yet.
    let out = await runMilestones(env, fakeFetch, new Date("2026-12-11T15:00:00Z"));
    expect(out.halfSent).toBe(0);
    out = await runMilestones(env, fakeFetch, now);
    expect(out.halfSent).toBe(1);
    expect(emails.map((e) => e.to[0])).toEqual(["jordan@acme.com", "owner@acme.com"]);
    expect(emails[0].subject).toMatch(/halfway/);
    expect(emails[0].text).toContain("day 5 of 10");
    expect(emails[0].text).not.toMatch(/token=/); // no link: their private link already shows status
    expect((await runMilestones(env, fakeFetch, now)).halfSent).toBe(0);
  });

  it("is a clean no-op without Resend: nothing sent, nothing marked", async () => {
    delete env.RESEND_API_KEY;
    await runningProject();
    await setClock("2026-12-07T14:00:00.000Z", "2026-12-21T14:00:00.000Z");
    const out = await runMilestones(env, fakeFetch, now);
    expect(out).toMatchObject({ halfSent: 0, fullSent: 0, testimonialRequests: 0 });
    expect(emails).toHaveLength(0);
    expect((await row()).milestone_half_sent_at).toBeNull();
  });

  it("at the deadline: 'delivery day' email and a #sprint-ops alert if staging isn't in review", async () => {
    await runningProject();
    await setClock("2026-12-07T14:00:00.000Z", "2026-12-21T14:00:00.000Z");
    emails = [];
    slack = [];
    const out = await runMilestones(env, fakeFetch, new Date("2026-12-21T15:00:00Z"));
    expect(out.fullSent).toBe(1);
    expect(out.deadlineAlerts).toBe(1);
    expect(emails.every((e) => /delivery day/.test(e.subject))).toBe(true);
    expect(JSON.stringify(posts("sprint"))).toContain("Deadline reached");
    // The 50% email was skipped (deadline already here), not sent late.
    expect(emails.some((e) => /halfway/.test(e.subject))).toBe(false);
    expect(await events()).toContain("milestone.half_skipped");
  });

  it("at the deadline while in review: 'sprint complete' wording, no alert", async () => {
    await runningProject();
    await setClock("2026-12-07T14:00:00.000Z", "2026-12-21T14:00:00.000Z");
    await env.DB.prepare("UPDATE onboarding_sessions SET status = 'IN_REVIEW' WHERE project_id = 'ZP-2026-040'").run();
    emails = [];
    slack = [];
    const out = await runMilestones(env, fakeFetch, new Date("2026-12-21T15:00:00Z"));
    expect(out).toMatchObject({ fullSent: 1, deadlineAlerts: 0 });
    expect(emails[0].subject).toMatch(/sprint complete/);
  });

  it("never sends a stale backlog when Resend is turned on later", async () => {
    await runningProject();
    await setClock("2026-12-07T14:00:00.000Z", "2026-12-21T14:00:00.000Z");
    emails = [];
    const out = await runMilestones(env, fakeFetch, new Date("2026-12-28T15:00:00Z"));
    expect(out.fullSent).toBe(0);
    expect(emails).toHaveLength(0);
    expect(await events()).toContain("milestone.full_skipped");
  });
});

describe("testimonials", () => {
  async function requested() {
    await runningProject();
    await launch("ZP-2026-040", new Date(Date.now() - 4 * 86_400_000).toISOString());
    emails = [];
    const out = await runMilestones(env, fakeFetch, new Date(), "https://portal.test");
    expect(out.testimonialRequests).toBe(1);
    return tokenFrom(emails[0].text, "testimonial");
  }

  it("asks 3 days after launch, once, and only with Resend and a portal address", async () => {
    await runningProject();
    await launch("ZP-2026-040", new Date(Date.now() - 2 * 86_400_000).toISOString());
    expect((await runMilestones(env, fakeFetch, new Date(), "https://portal.test")).testimonialRequests).toBe(0); // too soon
    await env.DB.prepare("UPDATE onboarding_sessions SET launched_at = ?").bind(new Date(Date.now() - 4 * 86_400_000).toISOString()).run();
    expect((await runMilestones(env, fakeFetch, new Date(), null)).testimonialRequests).toBe(0); // no link base
    delete env.RESEND_API_KEY;
    expect((await runMilestones(env, fakeFetch, new Date(), "https://portal.test")).testimonialRequests).toBe(0); // no Resend
    env.RESEND_API_KEY = "re_test";
    emails = [];
    expect((await runMilestones(env, fakeFetch, new Date(), "https://portal.test")).testimonialRequests).toBe(1);
    expect(emails[0].text).toContain("https://portal.test/testimonial?token=");
    expect((await runMilestones(env, fakeFetch, new Date(), "https://portal.test")).testimonialRequests).toBe(0);
  });

  it("saves the quote as PENDING, shows nothing publicly until you approve it", async () => {
    const t = await requested();
    const view = await req("/api/testimonial", { headers: auth(t) });
    expect(view.json).toMatchObject({ status: "REQUESTED", suggestedName: "Jordan Lee", businessDays: 10 });

    const bad = await req("/api/testimonial", { method: "POST", headers: json(t), body: JSON.stringify({ quote: "Great", authorName: "J" }) });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.json.fields).sort()).toEqual(["authorName", "consent", "quote"]);

    const quote = "We stopped copying bookings into Slack by hand. It saved our front desk about six hours a week.";
    const ok = await req("/api/testimonial", {
      method: "POST",
      headers: json(t),
      body: JSON.stringify({ quote, authorName: "Jordan Lee", authorRole: "Owner", consent: true, linkUrl: "https://senja.io/p/acme" }),
    });
    expect(ok.json.status).toBe("PENDING");
    expect(JSON.stringify(posts("sprint"))).toContain("New testimonial to approve");

    let pub = await req("/api/testimonials");
    expect(pub.json.testimonials).toEqual([]);

    const list = await req("/api/admin/testimonials?status=PENDING", { headers: admin });
    const id = list.json.testimonials[0].id;
    const ap = await req(`/api/admin/testimonials/${id}/approve`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ headline: "Replaced 6 hours a week of manual booking updates" }),
    });
    expect(ap.json.status).toBe("APPROVED");

    pub = await req("/api/testimonials");
    expect(pub.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(pub.json.testimonials).toHaveLength(1);
    expect(pub.json.testimonials[0]).toMatchObject({
      quote,
      authorName: "Jordan Lee",
      authorRole: "Owner",
      company: "Acme Barbers",
      headline: "Replaced 6 hours a week of manual booking updates",
      tier: "TIER_2",
      businessDays: 10,
      linkUrl: "https://senja.io/p/acme",
    });
    // Nothing that identifies the client beyond what they agreed to show.
    for (const k of ["owner@acme.com", "jordan@acme.com", "consent_ip", "ZP-2026-040"]) expect(JSON.stringify(pub.json)).not.toContain(k);

    // After approval the link just says thanks.
    expect((await req("/api/testimonial", { method: "POST", headers: json(t), body: JSON.stringify({ quote: "x" }) })).json.status).toBe("APPROVED");
  });

  it("lets you get the link by hand, and rejects keep it off the site", async () => {
    await runningProject();
    expect((await req("/api/admin/sessions/ZP-2026-040/testimonial-link", { method: "POST", headers: admin })).status).toBe(409);
    await launch();
    const r = await req("/api/admin/sessions/ZP-2026-040/testimonial-link", { method: "POST", headers: admin });
    const t = tokenFrom(r.json.link, "testimonial");
    await req("/api/testimonial", {
      method: "POST",
      headers: json(t),
      body: JSON.stringify({ quote: "Fast, clear and the site works. Booking requests doubled.", authorName: "Jordan", consent: true }),
    });
    await req(`/api/admin/testimonials/${r.json.testimonialId}/reject`, { method: "POST", headers: admin });
    expect((await req("/api/testimonials")).json.testimonials).toEqual([]);
  });
});

describe("invoice from a HubSpot scoping deal", () => {
  const fromDeal = (body: Record<string, unknown>) =>
    req("/api/admin/invoices/from-deal", { method: "POST", headers: admin, body: JSON.stringify(body) });

  it("prefills project_id, tier, company and contact, keeps bank-only at $500+, and moves the deal", async () => {
    const r = await fromDeal({ dealId: "9001" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ projectId: `ZP-${new Date().getUTCFullYear()}-001`, tier: "TIER_2", amountCents: 550000, bankOnly: true, sent: false });
    const create = stripeCalls.find((c) => c.method === "POST" && c.path === "/v1/invoices")!.body!;
    expect(create.get("metadata[project_id]")).toBe(r.json.projectId);
    expect(create.get("metadata[tier]")).toBe("TIER_2"); // from "(Tier 2)" in the deal name
    expect(create.get("metadata[company_name]")).toBe("River Co");
    expect(create.get("metadata[contact_name]")).toBe("Alex Rivera");
    expect(create.get("metadata[contact_email]")).toBe("alex@riverco.com");
    expect(create.get("metadata[hubspot_deal_id]")).toBe("9001");
    expect(create.get("payment_settings[payment_method_types][0]")).toBe("us_bank_account");
    expect(stripeCalls.some((c) => c.path.endsWith("/send"))).toBe(false); // draft by default: you check it first
    const patch = hubspot.find((h) => h.method === "PATCH")!;
    expect(patch.path).toBe("/crm/v3/objects/deals/9001");
    expect(patch.body.properties).toMatchObject({ dealstage: "contractsent", amount: "5500.00" });
  });

  it("reuses the same project id for the same deal, and sends when asked", async () => {
    const a = await fromDeal({ dealId: "9001", tier: "TIER_3", amountCents: 500000, milestone: "deposit" });
    const b = await fromDeal({ dealId: "9001", tier: "TIER_3", amountCents: 500000, milestone: "deposit", send: true });
    expect(b.json.projectId).toBe(a.json.projectId);
    expect(b.json.sent).toBe(true);
    const other = await fromDeal({ dealId: "9002", tier: "TIER_1" });
    expect(other.json.projectId).not.toBe(a.json.projectId);
    expect(other.json.amountCents).toBe(150000);
  });

  it("checks its inputs and says what's missing", async () => {
    expect((await req("/api/admin/invoices/from-deal", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fromDeal({ dealId: "abc" })).status).toBe(400);
    expect((await fromDeal({ dealId: "404" })).status).toBe(502);
    delete env.HUBSPOT_ACCESS_TOKEN;
    expect((await fromDeal({ dealId: "9001" })).status).toBe(503);
  });

  it("carries the deal id through payment to the zp-landing hand-off", async () => {
    await stripe(invoice({ deal: "9001" }));
    expect((await row()).hubspot_deal_id).toBe("9001");
  });
});
