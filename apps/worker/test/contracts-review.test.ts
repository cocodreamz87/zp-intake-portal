/**
 * $500+ bank-only rule, business check (KYB), PandaDoc contract states,
 * /review launch sign-off, and #worker-errors alerts. Nothing real is called:
 * Stripe, PandaDoc, Resend, zp-landing, GitHub and Slack are all fakes below.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { app, setOutboundFetch } from "../src/index";
import { hmacSha256Hex, toBase64 } from "../src/crypto";
import { runScheduled } from "../src/followups";
import { redact } from "../src/services/errors";
import type { Env } from "../src/env";
import { fakeD1, fakePng, fakeR2 } from "./fakes";

const ENC_KEY = toBase64(new Uint8Array(32).map((_, i) => 100 + i));
const ADMIN = "b".repeat(40);
const WHSEC = "whsec_unit_test";
const SLACK_SIGNING = "slack-signing-secret-test";
const PD_KEY = "pandadoc-shared-key-test";
const HOOK = (n: string) => `https://hooks.slack.com/services/T000/B000/${n}`;
const RESPONSE_URL = "https://hooks.slack.com/actions/T000/123/abc";
const PDF = new TextEncoder().encode("%PDF-1.7\nsigned\n%%EOF");

let env: Env;
let r2: ReturnType<typeof fakeR2>;
let pending: Promise<unknown>[];
let emails: Array<{ to: string[]; subject: string; text: string }>;
let slack: Array<{ url: string; body: any }>;
let stripeCalls: Array<{ method: string; path: string; body: URLSearchParams | null }>;
let stripeRail: string; // what the fake Stripe says paid the invoice
let stripeFail: number | null;
let pd: {
  docs: Map<string, { status: string; metadata: any; body: any }>;
  sends: string[];
  creates: number;
  nextStatus: string;
};
let landing: Array<{ path: string; query: string; body: any; secret: string | null }>;

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
  return { status: res.status, json };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const admin = { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" };
const posts = (n: string) => slack.filter((p) => p.url === HOOK(n));
const all = (x: unknown) => JSON.stringify(x);

async function stripe(event: unknown) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = await hmacSha256Hex(WHSEC, `${t}.${body}`);
  return req("/api/stripe/webhook", { method: "POST", body, headers: { "Stripe-Signature": `t=${t},v1=${sig}` } });
}

function invoice(over: { id?: string; amount?: number; tier?: string; project?: string; email?: string; charge?: unknown } = {}) {
  return {
    id: over.id ?? "evt_1",
    type: "invoice.paid",
    data: {
      object: {
        id: "in_1",
        customer_email: over.email ?? "owner@acme.com",
        customer_name: "Acme Barbers",
        amount_paid: over.amount ?? 150000,
        currency: "usd",
        ...(over.charge !== undefined ? { charge: over.charge } : {}),
        metadata: {
          project_id: over.project ?? "ZP-2026-020",
          tier: over.tier ?? "TIER_2",
          company_name: "Acme Barbers",
          contact_name: "Jordan Lee",
          integrations: "STRIPE_SECRET_KEY",
        },
      },
    },
  };
}

const bankCharge = { id: "ch_b", payment_method_details: { type: "us_bank_account" } };
const cardCharge = { id: "ch_c", payment_method_details: { type: "card" } };

function token() {
  const m = /token=([A-Za-z0-9_-]{43})/.exec(emails.at(-1)!.text);
  if (!m) throw new Error("no token in the last email");
  return m[1];
}

async function events() {
  return ((await env.DB.prepare("SELECT event, detail FROM audit_log ORDER BY id").all<{ event: string; detail: string }>()).results ?? []);
}

async function row(projectId = "ZP-2026-020") {
  return env.DB.prepare("SELECT * FROM onboarding_sessions WHERE project_id = ?").bind(projectId).first<any>();
}

function payload(logoKey: string, over: Record<string, unknown> = {}) {
  return {
    registrarProvider: "Cloudflare",
    registrarDelegatedConfirmed: true,
    cloudflareAdminConfirmed: true,
    githubTarget: "acme-barbers",
    legalBusinessName: "Acme Barbers LLC",
    einOrRegistration: "12-3456789",
    logoKey,
    primaryHex: "#B91C1C",
    secondaryHex: "#111111",
    font: { mode: "system" },
    copy: { mode: "link", url: "https://www.notion.so/acme/final-copy" },
    copyFinalizedConfirmed: true,
    secrets: { STRIPE_SECRET_KEY: "sk_test_clientkey123" },
    adminEmails: ["owner@acme.com"],
    spocName: "Jordan Lee",
    spocEmail: "jordan@acme.com",
    ...over,
  };
}

async function submit(t: string, over: Record<string, unknown> = {}) {
  const fd = new FormData();
  fd.append("file", new File([fakePng(1600, 6)], "logo.png", { type: "image/png" }));
  fd.append("kind", "logo");
  const up = await req("/api/assets/upload", { method: "POST", body: fd, headers: auth(t) });
  return req("/api/onboarding/submit", {
    method: "POST",
    headers: { ...auth(t), "Content-Type": "application/json" },
    body: JSON.stringify(payload(up.json.key, over)),
  });
}

beforeEach(() => {
  r2 = fakeR2();
  pending = [];
  emails = [];
  slack = [];
  stripeCalls = [];
  stripeRail = "us_bank_account";
  stripeFail = null;
  pd = { docs: new Map(), sends: [], creates: 0, nextStatus: "document.draft" };
  landing = [];
  env = {
    DB: fakeD1(),
    ASSETS_BUCKET: r2.bucket,
    AGENCY_NAME: "ZinkPress",
    AGENCY_EMAIL: "ZinkPress@proton.me",
    PORTAL_URL: "",
    BUSINESS_TIMEZONE: "America/New_York",
    HOLIDAYS: "",
    RECEIPT_FROM_EMAIL: "hello@zinkpress.test",
    RESEND_API_KEY: "re_test",
    STRIPE_WEBHOOK_SECRET: WHSEC,
    SECRETS_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_API_TOKEN: ADMIN,
    STRIPE_SECRET_KEY: "rk_test_unitkey000000",
    SLACK_WEBHOOK_ERRORS: HOOK("errors"),
    SLACK_WEBHOOK_APPROVALS: HOOK("approvals"),
    SLACK_WEBHOOK_CONTRACTS: HOOK("contracts"),
    SLACK_SIGNING_SECRET: SLACK_SIGNING,
    ZP_LANDING_ONBOARD_URL: "https://landing.test/api/onboard",
    ZP_LANDING_WEBHOOK_SECRET: "landing-secret",
  } as Env;

  setOutboundFetch((async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method || "GET").toUpperCase();
    if (url.hostname === "api.resend.com") {
      const b = JSON.parse(String(init.body));
      emails.push({ to: b.to, subject: b.subject, text: b.text });
      return Response.json({ id: `email_${emails.length}` });
    }
    if (url.hostname === "api.github.com") return Response.json({ login: "acme-barbers", type: "Organization" });
    if (url.hostname === "hooks.slack.com") {
      slack.push({ url: url.href, body: JSON.parse(String(init.body)) });
      return new Response("ok");
    }
    if (url.hostname === "landing.test") {
      landing.push({
        path: url.pathname,
        query: url.search,
        body: url.pathname === "/api/contracts/upload" ? new Uint8Array(init.body as ArrayBuffer) : JSON.parse(String(init.body)),
        secret: new Headers(init.headers).get("X-Webhook-Secret"),
      });
      return Response.json({ ok: true }, { status: url.pathname === "/api/contracts/upload" ? 201 : 200 });
    }
    if (url.hostname === "api.stripe.com") {
      const body = init.body ? new URLSearchParams(String(init.body)) : null;
      stripeCalls.push({ method, path: url.pathname + url.search, body });
      if (stripeFail) return new Response('{"error":{"message":"boom sk_test_shouldberedacted"}}', { status: stripeFail });
      if (url.pathname === "/v1/invoice_payments") return Response.json({ data: [{ status: "paid", payment: { payment_intent: "pi_1" } }] });
      if (url.pathname === "/v1/payment_intents/pi_1") return Response.json({ id: "pi_1", latest_charge: { payment_method_details: { type: stripeRail } } });
      if (url.pathname === "/v1/customers" && method === "GET") return Response.json({ data: [] });
      if (url.pathname === "/v1/customers") return Response.json({ id: "cus_1" });
      if (url.pathname === "/v1/invoices") return Response.json({ id: "in_new" });
      if (url.pathname === "/v1/invoiceitems") return Response.json({ id: "ii_1" });
      if (url.pathname.endsWith("/finalize")) return Response.json({ id: "in_new", status: "open", payment_settings: { payment_method_types: body?.get("x") ?? null } });
      if (url.pathname.endsWith("/send")) return Response.json({ id: "in_new", status: "open", hosted_invoice_url: "https://invoice.stripe.com/i/test" });
      return new Response("not faked", { status: 404 });
    }
    if (url.hostname === "api.pandadoc.com") {
      const p = url.pathname.replace("/public/v1", "");
      if (p === "/documents" && method === "GET") {
        const want = url.searchParams.get("metadata_project_id");
        const results = [...pd.docs.entries()].filter(([, d]) => d.metadata.project_id === want).map(([id, d]) => ({ id, status: d.status }));
        return Response.json({ results });
      }
      if (p === "/documents" && method === "POST") {
        pd.creates++;
        const body = JSON.parse(String(init.body));
        const id = `doc_${pd.creates}`;
        pd.docs.set(id, { status: pd.nextStatus, metadata: body.metadata, body });
        return Response.json({ id, status: "document.uploaded" }, { status: 201 });
      }
      const m = /^\/documents\/([^/]+)(\/send|\/download)?$/.exec(p);
      if (m) {
        const doc = pd.docs.get(m[1]);
        if (!doc) return new Response("{}", { status: 404 });
        if (m[2] === "/send") {
          pd.sends.push(m[1]);
          doc.status = "document.sent";
          return Response.json({ id: m[1], status: "document.sent" });
        }
        if (m[2] === "/download") return new Response(PDF, { headers: { "Content-Type": "application/pdf" } });
        return Response.json({ id: m[1], status: doc.status });
      }
    }
    throw new Error(`unexpected outbound call in test: ${method} ${url.href}`);
  }) as typeof fetch);
});

/* ------------------------------------------------------------------ */

describe("$500+ payments: bank transfer only", () => {
  it("lets an ACH payment through and records the rail", async () => {
    const r = await stripe(invoice({ charge: bankCharge }));
    expect(r.status).toBe(200);
    expect(r.json.session).toBe("created");
    expect((await row()).payment_rail).toBe("us_bank_account");
    expect((await row()).amount_cents).toBe(150000);
    expect(emails).toHaveLength(1);
  });

  it("blocks a card on a $1,500 invoice: no intake link, audit entry, #worker-errors alert", async () => {
    const r = await stripe(invoice({ charge: cardCharge }));
    expect(r.status).toBe(200);
    expect(r.json.blocked).toBe("stripe.blocked_card_over_500");
    expect(await row()).toBeNull();
    expect(emails).toHaveLength(0);
    expect((await events()).map((e) => e.event)).toContain("stripe.blocked_card_over_500");
    expect(posts("errors")).toHaveLength(1);
    expect(all(posts("errors")[0])).toContain("NOT sent");
    expect(all(posts("errors")[0])).toContain("ZP-2026-020");
    // Stripe re-sends: still nothing unlocked.
    expect((await stripe(invoice({ charge: cardCharge }))).json.duplicate).toBe(true);
    expect(await row()).toBeNull();
  });

  it("asks Stripe how it was paid when the event doesn't say, and blocks a card found that way", async () => {
    stripeRail = "card";
    const r = await stripe(invoice());
    expect(r.json.blocked).toBe("stripe.blocked_card_over_500");
    expect(stripeCalls.map((c) => c.path.split("?")[0])).toEqual(["/v1/invoice_payments", "/v1/payment_intents/pi_1"]);
  });

  it("accepts a bank transfer into the Stripe cash balance found through the API", async () => {
    stripeRail = "customer_balance";
    const r = await stripe(invoice());
    expect(r.json.session).toBe("created");
    expect((await row()).payment_rail).toBe("customer_balance");
  });

  it("accepts an invoice you marked paid by hand (out of band)", async () => {
    const ev = invoice();
    (ev.data.object as any).paid_out_of_band = true;
    expect((await stripe(ev)).json.session).toBe("created");
    expect((await row()).payment_rail).toBe("out_of_band");
  });

  it("holds a $500+ invoice with 503 when it can't check the rail, so Stripe retries later", async () => {
    delete env.STRIPE_SECRET_KEY;
    const r = await stripe(invoice());
    expect(r.status).toBe(503);
    expect(await row()).toBeNull();
    expect((await events()).map((e) => e.event)).toContain("stripe.rail_unverified");
    expect(all(posts("errors"))).toContain("STRIPE_SECRET_KEY");
    // Once the key is set, Stripe's retry of the same event goes through.
    env.STRIPE_SECRET_KEY = "rk_test_unitkey000000";
    expect((await stripe(invoice())).json.session).toBe("created");
  });

  it("doesn't check the rail under $500", async () => {
    const r = await stripe(invoice({ amount: 49_999, tier: "TIER_1", charge: cardCharge }));
    expect(r.json.session).toBe("created");
    expect(stripeCalls).toHaveLength(0);
  });
});

describe("POST /api/admin/invoices", () => {
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      projectId: "ZP-2026-030",
      tier: "TIER_2",
      companyName: "Acme Barbers",
      contactName: "Jordan Lee",
      contactEmail: "jordan@acme.com",
      integrations: ["STRIPE_SECRET_KEY"],
      amountCents: 275000,
      ...over,
    });

  it("needs the admin token and the Stripe key", async () => {
    expect((await req("/api/admin/invoices", { method: "POST", body: body() })).status).toBe(401);
    delete env.STRIPE_SECRET_KEY;
    expect((await req("/api/admin/invoices", { method: "POST", headers: admin, body: body() })).status).toBe(503);
  });

  it("makes a bank-only invoice at $500+ with the project metadata, then sends it", async () => {
    const r = await req("/api/admin/invoices", { method: "POST", headers: admin, body: body() });
    expect(r.status).toBe(201);
    expect(r.json.bankOnly).toBe(true);
    const create = stripeCalls.find((c) => c.method === "POST" && c.path === "/v1/invoices")!.body!;
    expect(create.getAll("payment_settings[payment_method_types][0]")).toEqual(["us_bank_account"]);
    expect(create.getAll("payment_settings[payment_method_types][1]")).toEqual(["customer_balance"]);
    expect([...create.keys()].some((k) => k.includes("payment_method_types") && create.get(k) === "card")).toBe(false);
    expect(create.get("metadata[project_id]")).toBe("ZP-2026-030");
    expect(create.get("metadata[tier]")).toBe("TIER_2");
    expect(create.get("metadata[company_name]")).toBe("Acme Barbers");
    expect(create.get("metadata[contact_name]")).toBe("Jordan Lee");
    expect(create.get("metadata[contact_email]")).toBe("jordan@acme.com");
    expect(create.get("metadata[integrations]")).toBe("STRIPE_SECRET_KEY");
    expect(stripeCalls.map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual([
      "GET /v1/customers",
      "POST /v1/customers",
      "POST /v1/invoices",
      "POST /v1/invoiceitems",
      "POST /v1/invoices/in_new/finalize",
      "POST /v1/invoices/in_new/send",
    ]);
    expect(stripeCalls.find((c) => c.path === "/v1/invoiceitems")!.body!.get("amount")).toBe("275000");
  });

  it("leaves payment methods to your Stripe defaults under $500", async () => {
    await req("/api/admin/invoices", { method: "POST", headers: admin, body: body({ amountCents: 30000, tier: "TIER_1" }) });
    const create = stripeCalls.find((c) => c.path === "/v1/invoices")!.body!;
    expect([...create.keys()].some((k) => k.startsWith("payment_settings"))).toBe(false);
  });

  it("reports a Stripe error to #worker-errors once, without the key", async () => {
    stripeFail = 500;
    const r = await req("/api/admin/invoices", { method: "POST", headers: admin, body: body() });
    expect(r.status).toBe(500);
    await req("/api/admin/invoices", { method: "POST", headers: admin, body: body() });
    const stripeAlerts = posts("errors").filter((p) => p.body.text.startsWith("🔴 Stripe error"));
    expect(stripeAlerts).toHaveLength(1); // the repeat is de-duplicated
    expect(all(stripeAlerts[0])).toContain("ZP-2026-030");
    expect(all(stripeAlerts[0])).not.toContain("sk_test_shouldberedacted");
    expect(all(posts("errors"))).not.toContain("rk_test_unitkey000000");
  });
});

describe("business check (KYB)", () => {
  it("Tier 2 needs the legal name and EIN, and a company-domain approver", async () => {
    await stripe(invoice({ charge: bankCharge }));
    const t = token();
    const session = await req("/api/session", { headers: auth(t) });
    expect(session.json.businessCheckRequired).toBe(true);
    expect(session.json.companyEmailRequired).toBe(true);

    const missing = await submit(t, { legalBusinessName: "", einOrRegistration: "" });
    expect(missing.status).toBe(422);
    expect(missing.json.fields.legalBusinessName).toBeTruthy();
    expect(missing.json.fields.einOrRegistration).toBeTruthy();

    const gmail = await submit(t, { spocEmail: "jordan@gmail.com" });
    expect(gmail.status).toBe(422);
    expect(gmail.json.fields.spocEmail).toMatch(/company/);

    const ok = await submit(t);
    expect(ok.status).toBe(200);
    const r = await row();
    expect(r.legal_business_name).toBe("Acme Barbers LLC");
    expect(r.ein_or_registration).toBe("12-3456789");

    // The admin view and the audit log never show the full number.
    const view = await req("/api/admin/sessions/ZP-2026-020", { headers: admin });
    expect(view.json.ein_or_registration).toBeUndefined();
    expect(view.json.ein_or_registration_last4).toBe("6789");
    expect(all(await events())).not.toContain("12-3456789");
  });

  it("flags a Tier 2 paid from a free mailbox, and the admin override lets a gmail approver through", async () => {
    await stripe(invoice({ email: "owner@gmail.com", charge: bankCharge }));
    expect((await events()).map((e) => e.event)).toContain("kyb.webmail_flagged");
    const t = token();
    expect((await submit(t, { spocEmail: "owner@gmail.com" })).status).toBe(422);
    const o = await req("/api/admin/sessions/ZP-2026-020/kyb-override", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ allowWebmail: true, reason: "sole proprietor, no domain yet" }),
    });
    expect(o.status).toBe(200);
    expect((await req("/api/session", { headers: auth(t) })).json.companyEmailRequired).toBe(false);
    expect((await submit(t, { spocEmail: "owner@gmail.com" })).status).toBe(200);
  });

  it("Tier 1 under $2,500 can skip the business details", async () => {
    await stripe(invoice({ tier: "TIER_1", amount: 150000, charge: bankCharge }));
    const t = token();
    expect((await req("/api/session", { headers: auth(t) })).json.businessCheckRequired).toBe(false);
    const r = await submit(t, { legalBusinessName: "", einOrRegistration: "", secrets: {}, adminEmails: [], spocEmail: "me@gmail.com" });
    expect(r.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */

async function slackClick(projectId: string, user = { id: "U123", name: "coco" }, secret = SLACK_SIGNING) {
  const payload = {
    type: "block_actions",
    user,
    response_url: RESPONSE_URL,
    actions: [{ action_id: "approve_send_contract", value: projectId }],
  };
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${await hmacSha256Hex(secret, `v0:${ts}:${body}`)}`;
  return req("/api/slack/interactions", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig },
  });
}

async function pandadocHook(events: unknown, key = PD_KEY) {
  const body = JSON.stringify(events);
  const sig = await hmacSha256Hex(key, body);
  return req(`/api/pandadoc/webhook?signature=${sig}`, { method: "POST", body, headers: { "Content-Type": "application/json" } });
}

describe("PandaDoc contract: draft -> Slack approve -> send -> signed backup", () => {
  beforeEach(() => {
    env.PANDADOC_API_KEY = "pd-test-key";
    env.PANDADOC_TEMPLATE_ID = "tmpl_msa_sow";
    env.PANDADOC_WEBHOOK_KEY = PD_KEY;
  });

  it("drafts the contract on invoice.paid with every token and asks #contract-approvals", async () => {
    await stripe(invoice({ charge: bankCharge }));
    const r = await row();
    expect(r.contract_status).toBe("DRAFT_PENDING_APPROVAL");
    expect(r.pandadoc_document_id).toBe("doc_1");
    const doc = pd.docs.get("doc_1")!.body;
    expect(doc.template_uuid).toBe("tmpl_msa_sow");
    expect(doc.recipients).toEqual([{ email: "owner@acme.com", first_name: "Jordan", last_name: "Lee", role: "Client" }]);
    const tokens = Object.fromEntries(doc.tokens.map((t: any) => [t.name, t.value]));
    expect(tokens).toMatchObject({
      "Client.CompanyName": "Acme Barbers",
      "Client.ContactName": "Jordan Lee",
      "Client.Email": "owner@acme.com",
      "Project.ID": "ZP-2026-020",
      "Project.Tier": "Tier 2",
      "Project.DeliveryBusinessDays": "10",
      "Project.Amount": "$1,500.00",
    });
    expect(tokens["Project.StartDate"]).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/);

    const card = posts("contracts")[0].body;
    expect(all(card)).toContain("https://app.pandadoc.com/a/#/documents/doc_1");
    const button = card.blocks.flatMap((b: any) => b.elements ?? []).find((e: any) => e.action_id === "approve_send_contract");
    expect(button.value).toBe("ZP-2026-020");
    expect(all(card)).not.toContain("token=");
  });

  it("never makes a second PandaDoc document for the same project", async () => {
    await stripe(invoice({ charge: bankCharge }));
    await env.DB.prepare("UPDATE onboarding_sessions SET pandadoc_document_id = NULL, contract_status = NULL").run();
    await req("/api/contracts/draft", { method: "POST", headers: admin, body: JSON.stringify({ projectId: "ZP-2026-020" }) });
    expect(pd.creates).toBe(1); // found the existing one by metadata_project_id
    expect((await row()).pandadoc_document_id).toBe("doc_1");
  });

  it("the Slack button sends it once, records who approved, and rewrites the message", async () => {
    await stripe(invoice({ charge: bankCharge }));
    const bad = await slackClick("ZP-2026-020", undefined, "wrong-secret");
    expect(bad.status).toBe(401);
    expect(pd.sends).toHaveLength(0);

    expect((await slackClick("ZP-2026-020")).status).toBe(200);
    await slackClick("ZP-2026-020"); // double click
    expect(pd.sends).toEqual(["doc_1"]);
    const r = await row();
    expect(r.contract_status).toBe("SENT");
    expect(r.contract_approved_by).toContain("coco (U123)");
    const updates = slack.filter((p) => p.url === RESPONSE_URL);
    expect(updates[0].body.replace_original).toBe(true);
    expect(all(updates[0].body)).toContain("Approved by coco (U123)");
    expect(all(updates[1].body)).toContain("already sent");
  });

  it("only listed approvers can send when SLACK_CONTRACT_APPROVERS is set", async () => {
    env.SLACK_CONTRACT_APPROVERS = "U999";
    await stripe(invoice({ charge: bankCharge }));
    await slackClick("ZP-2026-020", { id: "U123", name: "intern" });
    expect(pd.sends).toHaveLength(0);
    expect((await row()).contract_status).toBe("DRAFT_PENDING_APPROVAL");
    await slackClick("ZP-2026-020", { id: "U999", name: "coco" });
    expect(pd.sends).toEqual(["doc_1"]);
  });

  it("waits while PandaDoc is still preparing the draft, then the admin fallback sends it", async () => {
    pd.nextStatus = "document.uploaded";
    await stripe(invoice({ charge: bankCharge }));
    const early = await req("/api/admin/sessions/ZP-2026-020/send-contract", { method: "POST", headers: admin });
    expect(early.status).toBe(425);
    expect((await row()).contract_status).toBe("DRAFT_PENDING_APPROVAL");
    pd.docs.get("doc_1")!.status = "document.draft";
    const ok = await req("/api/admin/sessions/ZP-2026-020/send-contract", { method: "POST", headers: admin });
    expect(ok.status).toBe(200);
    expect((await row()).contract_status).toBe("SENT");
    expect((await row()).contract_approved_by).toBe("admin API");
  });

  it("on document.completed: SIGNED, PDF in R2, and into Drive once the client is onboarded", async () => {
    await stripe(invoice({ charge: bankCharge }));
    await slackClick("ZP-2026-020");
    expect((await pandadocHook([{ event: "document_state_changed", data: { id: "doc_1", status: "document.completed" } }], "wrong"))
      .status).toBe(401);

    const ok = await pandadocHook([{ event: "document_state_changed", data: { id: "doc_1", status: "document.completed" } }]);
    expect(ok.status).toBe(200);
    let r = await row();
    expect(r.contract_status).toBe("SIGNED");
    expect(r.contract_signed_at).toBeTruthy();
    expect(r.contract_r2_key).toBe("ZP-2026-020/contracts/ZP-2026-020-MSA-SOW-SIGNED.pdf");
    expect(r2.store.get(r.contract_r2_key)!.contentType).toBe("application/pdf");
    // Not onboarded on zp-landing yet (intake not submitted): the Drive copy waits.
    expect(landing.filter((l) => l.path === "/api/contracts/upload")).toHaveLength(0);
    expect(r.contract_drive_synced_at).toBeNull();

    // Client submits the intake -> zp-landing onboards them -> the hourly job copies the PDF.
    await submit(token());
    expect((await row()).landing_synced_at).toBeTruthy();
    await req("/api/admin/run-cron", { method: "POST", headers: admin });
    expect(landing.filter((l) => l.path === "/api/contracts/upload")).toHaveLength(1);
    expect((await row()).contract_drive_synced_at).toBeTruthy();
  });

  it("copies the signed PDF to the client's Drive right away when zp-landing already has them", async () => {
    await stripe(invoice({ charge: bankCharge }));
    await submit(token());
    await slackClick("ZP-2026-020");
    await pandadocHook([{ event: "document_state_changed", data: { id: "doc_1", status: "document.completed" } }]);
    const uploads = landing.filter((l) => l.path === "/api/contracts/upload");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].query).toContain("project_id=ZP-2026-020");
    expect(uploads[0].secret).toBe("landing-secret");
    expect(String.fromCharCode(...uploads[0].body.slice(0, 4))).toBe("%PDF");
    expect((await row()).contract_drive_synced_at).toBeTruthy();
    // A second completed event changes nothing.
    await pandadocHook([{ event: "document_state_changed", data: { id: "doc_1", status: "document.completed" } }]);
    expect(landing.filter((l) => l.path === "/api/contracts/upload")).toHaveLength(1);
  });

  it("records a declined contract and never moves a signed one backwards", async () => {
    await stripe(invoice({ charge: bankCharge }));
    await slackClick("ZP-2026-020");
    await pandadocHook([{ event: "document_state_changed", data: { id: "doc_1", status: "document.declined" } }]);
    expect((await row()).contract_status).toBe("DECLINED");
    await pandadocHook([{ event: "document_state_changed", data: { id: "doc_1", status: "document.completed" } }]);
    await pandadocHook([{ event: "document_state_changed", data: { id: "doc_1", status: "document.viewed" } }]);
    expect((await row()).contract_status).toBe("SIGNED");
  });
});

/* ------------------------------------------------------------------ */

describe("staging review and launch sign-off", () => {
  async function ready() {
    await stripe(invoice({ charge: bankCharge }));
    const intakeToken = token();
    await submit(intakeToken);
    const r = await req("/api/admin/sessions/ZP-2026-020/ready-for-review", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        stagingUrl: "https://zp-2026-020.pages.dev",
        loomUrl: "https://www.loom.com/share/0123456789abcdef0123456789abcdef",
        releaseNotes: "Home, About, Services, Contact. Booking button wired to theCut.",
      }),
    });
    return { r, intakeToken };
  }

  it("checks the links before sending anything", async () => {
    await stripe(invoice({ charge: bankCharge }));
    await submit(token());
    const bad = await req("/api/admin/sessions/ZP-2026-020/ready-for-review", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ stagingUrl: "https://ok.dev", loomUrl: "https://youtube.com/x", releaseNotes: "notes" }),
    });
    expect(bad.status).toBe(400);
    expect((await row()).status).toBe("CLOCK_RUNNING");
  });

  it("sets IN_REVIEW, emails the approver a private /review link and posts it to #staging-approvals", async () => {
    const { r, intakeToken } = await ready();
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("IN_REVIEW");
    expect(r.json.link).toMatch(/^https:\/\/api\.test\/review\?token=[A-Za-z0-9_-]{43}$/);
    expect((await row()).status).toBe("IN_REVIEW");
    const reviewMail = emails.filter((e) => e.subject.includes("ready for review"));
    expect(reviewMail.map((e) => e.to[0])).toEqual(["jordan@acme.com", "owner@acme.com"]);
    expect(posts("approvals")[0].body.text).toContain("Staging ready for client review");
    expect(all(posts("approvals")[0])).toContain(r.json.link);
    // The old intake link stops working; the new one opens the review.
    expect((await req("/api/review", { headers: auth(intakeToken) })).status).toBe(401);
    const t = token();
    const view = await req("/api/review", { headers: auth(t) });
    expect(view.status).toBe(200);
    expect(view.json.loomEmbedUrl).toBe("https://www.loom.com/embed/0123456789abcdef0123456789abcdef");
    expect(view.json.stagingUrl).toBe("https://zp-2026-020.pages.dev");
  });

  it("there's nothing to review before staging is ready", async () => {
    await stripe(invoice({ charge: bankCharge }));
    const t = token();
    expect((await req("/api/review", { headers: auth(t) })).status).toBe(409);
    expect((await req("/api/review/approve", { method: "POST", headers: auth(t), body: "{}" })).status).toBe(409);
  });

  it("approval needs the box and a typed name; then LAUNCHED, 7-day key wipe, IP logged, Slack and Airtable Complete", async () => {
    await ready();
    const t = token();
    const approve = (b: unknown) =>
      req("/api/review/approve", {
        method: "POST",
        headers: { ...auth(t), "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", "User-Agent": "UnitTest/1.0" },
        body: JSON.stringify(b),
      });
    const missing = await approve({ confirmed: false, signerName: "" });
    expect(missing.status).toBe(422);
    expect(missing.json.fields.confirmed).toBeTruthy();
    expect(missing.json.fields.signerName).toBeTruthy();

    const before = Date.now();
    const ok = await approve({ confirmed: true, signerName: "Jordan Lee" });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("LAUNCHED");
    const r = await row();
    expect(r.status).toBe("LAUNCHED");
    expect(r.launched_at).toBeTruthy();
    expect(r.client_approval_ip).toBe("203.0.113.7");
    expect(r.client_approval_name).toBe("Jordan Lee");
    const purgeIn = Date.parse(r.secrets_purge_after) - before;
    expect(purgeIn).toBeGreaterThan(6.9 * 86_400_000);
    expect(purgeIn).toBeLessThan(7.1 * 86_400_000);

    const ev = (await events()).find((e) => e.event === "review.approved")!;
    expect(JSON.parse(ev.detail)).toMatchObject({ signerName: "Jordan Lee", ip: "203.0.113.7" });
    expect(posts("approvals").at(-1)!.body.text).toBe("🚀 Client approved launch: ZP-2026-020");
    const status = landing.find((l) => l.path === "/api/clients/status")!;
    expect(status.body).toMatchObject({ project_id: "ZP-2026-020", status: "Complete" });
    expect((await row()).landing_completed_at).toBeTruthy();

    // A second click changes nothing.
    expect((await approve({ confirmed: true, signerName: "Someone Else" })).json.status).toBe("LAUNCHED");
    expect((await row()).client_approval_name).toBe("Jordan Lee");
    expect(landing.filter((l) => l.path === "/api/clients/status")).toHaveLength(1);
  });

  it("the hourly cron wipes the client's encrypted keys 7 days after sign-off", async () => {
    await ready();
    const t = token();
    await req("/api/review/approve", {
      method: "POST",
      headers: { ...auth(t), "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true, signerName: "Jordan Lee" }),
    });
    expect((await row()).encrypted_secrets_blob).toBeTruthy();
    await env.DB.prepare("UPDATE onboarding_sessions SET secrets_purge_after = ?").bind(new Date(Date.now() - 1000).toISOString()).run();
    await runScheduled(env, async () => new Response("{}"));
    const r = await row();
    expect(r.encrypted_secrets_blob).toBeNull();
    expect(r.secrets_purged_at).toBeTruthy();
  });

  it("retries the Airtable Complete update from the hourly job if zp-landing was down", async () => {
    await ready();
    const t = token();
    delete env.ZP_LANDING_ONBOARD_URL; // zp-landing unreachable at sign-off
    await req("/api/review/approve", {
      method: "POST",
      headers: { ...auth(t), "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true, signerName: "Jordan Lee" }),
    });
    expect((await row()).landing_completed_at).toBeNull();
    env.ZP_LANDING_ONBOARD_URL = "https://landing.test/api/onboard";
    await req("/api/admin/run-cron", { method: "POST", headers: admin });
    expect((await row()).landing_completed_at).toBeTruthy();
  });
});

describe("#worker-errors helper", () => {
  it("redacts keys, tokens and webhook URLs", () => {
    const out = redact("sk_live_abc123 rk_test_xyz whsec_123 https://hooks.slack.com/services/T/B/C token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA Bearer abcdefghijklmnop");
    expect(out).not.toMatch(/abc123|xyz|whsec_123|T\/B\/C|AAAAAAAA|abcdefghijklmnop/);
  });
});
