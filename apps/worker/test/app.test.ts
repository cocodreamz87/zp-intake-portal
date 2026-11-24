import { beforeEach, describe, expect, it } from "vitest";
import { app, setOutboundFetch } from "../src/index";
import { decryptJson, hmacSha256Hex, toBase64 } from "../src/crypto";
import { runScheduled } from "../src/followups";
import type { Env } from "../src/env";
import { fakeD1, fakeJira, fakePng, fakeR2 } from "./fakes";

const ENC_KEY = toBase64(new Uint8Array(32).map((_, i) => 200 - i));
const ADMIN = "a".repeat(40);
const WHSEC = "whsec_unit_test";

let env: Env;
let r2: ReturnType<typeof fakeR2>;
let jira: ReturnType<typeof fakeJira>;
let emails: Array<{ to: string[]; subject: string; text: string; key: string | null }>;
let pending: Promise<unknown>[];
let slack: Array<{ url: string; body: any }>;
let slackStatus: number;

const ctx = () =>
  ({ waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;

async function req(path: string, init: RequestInit = {}) {
  const res = await app.fetch(new Request(`https://api.test${path}`, init), env, ctx());
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, headers: res.headers };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function stripe(event: unknown, secret = WHSEC) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = await hmacSha256Hex(secret, `${t}.${body}`);
  return req("/api/stripe/webhook", { method: "POST", body, headers: { "Stripe-Signature": `t=${t},v1=${sig}` } });
}

function paidInvoice(over: Record<string, unknown> = {}) {
  return {
    id: "evt_100",
    type: "invoice.paid",
    data: {
      object: {
        id: "in_100",
        customer_email: "owner@acme.com",
        customer_name: "Acme Barbers",
        metadata: { project_id: "ZP-2026-014", tier: "TIER_2", integrations: "STRIPE_SECRET_KEY" },
      },
    },
    ...over,
  };
}

function tokenFromLastEmail() {
  const m = /token=([A-Za-z0-9_-]{43})/.exec(emails.at(-1)!.text);
  if (!m) throw new Error("no token in email");
  return m[1];
}

async function uploadLogo(token: string, bytes: Uint8Array, name = "logo.png") {
  const fd = new FormData();
  fd.append("file", new File([bytes], name, { type: "image/png" }));
  fd.append("kind", "logo");
  return req("/api/assets/upload", { method: "POST", body: fd, headers: auth(token) });
}

function goodPayload(logoKey: string) {
  return {
    registrarProvider: "Cloudflare",
    registrarDelegatedConfirmed: true,
    cloudflareAdminConfirmed: true,
    githubTarget: "acme-barbers",
    logoKey,
    primaryHex: "#B91C1C",
    secondaryHex: "#111111",
    font: { mode: "google", family: "Oswald" },
    copy: { mode: "link", url: "https://www.notion.so/acme/final-copy" },
    copyFinalizedConfirmed: true,
    secrets: { STRIPE_SECRET_KEY: "sk_test_supersecret123" },
    adminEmails: ["owner@acme.com"],
    spocName: "Jordan Lee",
    spocEmail: "Jordan@Acme.com",
  };
}

beforeEach(() => {
  r2 = fakeR2();
  jira = fakeJira();
  emails = [];
  pending = [];
  slack = [];
  slackStatus = 200;
  env = {
    DB: fakeD1(),
    ASSETS_BUCKET: r2.bucket,
    AGENCY_NAME: "ZinkPress",
    AGENCY_EMAIL: "ZinkPress@proton.me",
    PORTAL_URL: "https://intake.test",
    ALLOWED_ORIGIN: "https://intake.test",
    BUSINESS_TIMEZONE: "America/New_York",
    HOLIDAYS: "",
    RECEIPT_FROM_EMAIL: "hello@zinkpress.test",
    JIRA_DOMAIN: "zinkpress.atlassian.net",
    JIRA_PROJECT_KEY: "ZP",
    JIRA_EMAIL: "me@example.com",
    JIRA_API_TOKEN: "jira-test",
    STRIPE_WEBHOOK_SECRET: WHSEC,
    SECRETS_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_API_TOKEN: ADMIN,
    RESEND_API_KEY: "re_test",
  } as Env;

  setOutboundFetch((async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("https://api.resend.com/")) {
      const b = JSON.parse(String(init.body));
      emails.push({ to: b.to, subject: b.subject, text: b.text, key: new Headers(init.headers).get("Idempotency-Key") });
      return Response.json({ id: `email_${emails.length}` });
    }
    if (url.startsWith("https://api.github.com/users/")) {
      const name = decodeURIComponent(url.split("/").pop()!);
      return name === "nobody-here"
        ? new Response("{}", { status: 404 })
        : Response.json({ login: name, type: "Organization" });
    }
    if (url.includes(".atlassian.net/")) return jira.handle(url, init);
    if (url.startsWith("https://hooks.slack.com/")) {
      slack.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(slackStatus === 200 ? "ok" : "server_error", { status: slackStatus });
    }
    throw new Error(`unexpected outbound call in test: ${url}`);
  }) as typeof fetch);
});

describe("Stripe webhook", () => {
  it("rejects unsigned or badly signed calls", async () => {
    expect((await req("/api/stripe/webhook", { method: "POST", body: "{}" })).status).toBe(400);
    expect((await stripe(paidInvoice(), "whsec_wrong")).status).toBe(400);
  });

  it("creates the intake, emails a link, and ignores Stripe's repeat delivery", async () => {
    const r = await stripe(paidInvoice());
    expect(r.status).toBe(200);
    expect(r.json.session).toBe("created");
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toEqual(["owner@acme.com"]);
    const token = tokenFromLastEmail();

    const dup = await stripe(paidInvoice());
    expect(dup.json.duplicate).toBe(true);
    expect(emails).toHaveLength(1);

    // Only the hash is in the database.
    const row: any = await env.DB.prepare("SELECT token_hash FROM onboarding_sessions").first();
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("answers 200 but does nothing for invoices missing metadata", async () => {
    const bad = paidInvoice({ id: "evt_bad" });
    (bad.data.object.metadata as any) = {};
    const r = await stripe(bad);
    expect(r.status).toBe(200);
    expect(r.json.ignored).toMatch(/project_id/);
    expect(emails).toHaveLength(0);
  });
});

describe("client intake flow", () => {
  let token: string;
  beforeEach(async () => {
    await stripe(paidInvoice());
    token = tokenFromLastEmail();
  });

  it("rejects bad or missing tokens", async () => {
    expect((await req("/api/session")).status).toBe(401);
    expect((await req("/api/session", { headers: auth("x".repeat(43)) })).status).toBe(401);
  });

  it("shows the project to the client (no secrets, no internal ids)", async () => {
    const r = await req("/api/session", { headers: auth(token) });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      projectId: "ZP-2026-014",
      tier: "TIER_2",
      requiredIntegrations: ["STRIPE_SECRET_KEY"],
      agencyEmail: "ZinkPress@proton.me",
      timeZone: "America/New_York",
      status: "AWAITING_CREDENTIALS",
    });
    expect(JSON.stringify(r.json)).not.toMatch(/token_hash|"id"/);
  });

  it("checks logo bytes before saving to R2", async () => {
    const small = await uploadLogo(token, fakePng(500, 6));
    expect(small.status).toBe(422);
    const ok = await uploadLogo(token, fakePng(1600, 6), "../../evil.png");
    expect(ok.status).toBe(200);
    expect(ok.json.key).toMatch(/^ZP-2026-014\/assets\/logo-[0-9a-f-]+\.png$/);
    expect(r2.store.size).toBe(1);
  });

  it("won't start the clock until everything is valid", async () => {
    const { json } = await uploadLogo(token, fakePng(1600, 6));
    const p = goodPayload(json.key);
    const bad = await req("/api/onboarding/submit", {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ...p, cloudflareAdminConfirmed: false, secrets: {} }),
    });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.json.fields)).toEqual(expect.arrayContaining(["cloudflareAdminConfirmed", "secrets.STRIPE_SECRET_KEY"]));

    const fakeLogo = await req("/api/onboarding/submit", {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ...p, logoKey: "OTHER/assets/logo-x.png" }),
    });
    expect(fakeLogo.status).toBe(422);

    const ghost = await req("/api/onboarding/submit", {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ...p, githubTarget: "nobody-here" }),
    });
    expect(ghost.status).toBe(422);
    expect(ghost.json.fields.githubTarget).toMatch(/GitHub/);

    const row: any = await env.DB.prepare("SELECT status FROM onboarding_sessions").first();
    expect(row.status).toBe("AWAITING_CREDENTIALS");
  });

  it("valid submit: starts the clock, encrypts keys, creates Jira, emails receipt, and is safe to repeat", async () => {
    const { json } = await uploadLogo(token, fakePng(1600, 6));
    const submit = () =>
      req("/api/onboarding/submit", {
        method: "POST",
        headers: { ...auth(token), "Content-Type": "application/json" },
        body: JSON.stringify(goodPayload(json.key)),
      });

    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.clockStartedAt).toMatch(/T1[34]:00:00\.000Z$/); // 9 AM Eastern (EDT or EST)
    await Promise.all(pending);

    const row: any = await env.DB.prepare("SELECT * FROM onboarding_sessions").first();
    expect(row.status).toBe("CLOCK_RUNNING");
    expect(row.github_verified).toBe(1);
    expect(row.spoc_email).toBe("jordan@acme.com");
    expect(row.encrypted_secrets_blob).not.toContain("supersecret");
    expect(
      await decryptJson({ ciphertext: row.encrypted_secrets_blob, iv: row.secrets_iv }, ENC_KEY, "ZP-2026-014"),
    ).toEqual({ STRIPE_SECRET_KEY: "sk_test_supersecret123" });
    expect(row.jira_epic_key).toBe("ZP-1");
    expect(row.jira_synced_at).toBeTruthy();
    expect(row.receipt_sent_at).toBeTruthy();
    expect(jira.issues).toHaveLength(1 + 7); // epic + Tier 2 tasks
    const receipts = emails.filter((e) => e.subject.includes("sprint clock started"));
    expect(receipts.map((e) => e.to[0]).sort()).toEqual(["jordan@acme.com", "owner@acme.com"]);

    // Double-click: same answer, no second epic, no second receipt.
    const again = await submit();
    expect(again.status).toBe(200);
    expect(again.json.clockStartedAt).toBe(r.json.clockStartedAt);
    await Promise.all(pending);
    expect(jira.issues).toHaveLength(8);
    expect(emails.filter((e) => e.subject.includes("sprint clock started"))).toHaveLength(2);

    // Audit log has key names, never values.
    const log = await env.DB.prepare("SELECT detail FROM audit_log").all<{ detail: string }>();
    expect(JSON.stringify(log.results)).not.toContain("supersecret");
  });

  it("retries Jira from the cron job if it failed the first time", async () => {
    jira = fakeJira({ failBulkOnce: true });
    const { json } = await uploadLogo(token, fakePng(1600, 6));
    await req("/api/onboarding/submit", {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify(goodPayload(json.key)),
    });
    await Promise.all(pending);
    let row: any = await env.DB.prepare("SELECT jira_synced_at, last_error FROM onboarding_sessions").first();
    expect(row.jira_synced_at).toBeNull();
    expect(row.last_error).toMatch(/jira/);

    await runScheduled(env, (async (u: string, i: RequestInit) => jira.handle(u, i)) as unknown as typeof fetch);
    row = await env.DB.prepare("SELECT jira_synced_at, last_error FROM onboarding_sessions").first();
    expect(row.jira_synced_at).toBeTruthy();
    expect(row.last_error).toBeNull();
    expect(jira.issues.filter((i) => i.type === "Epic")).toHaveLength(1);
    expect(jira.issues).toHaveLength(8);
  });
});

describe("admin and housekeeping", () => {
  it("admin routes need the admin token", async () => {
    expect((await req("/api/admin/sessions/ZP-1")).status).toBe(401);
    expect((await req("/api/admin/sessions/ZP-1", { headers: auth("wrong".repeat(10)) })).status).toBe(401);
  });

  it("manual intake, expiry, and reissue", async () => {
    const created = await req("/api/admin/sessions", {
      method: "POST",
      headers: { ...auth(ADMIN), "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "ZP-CASH-1", tier: "TIER_1", clientEmail: "c@client.com", clientName: "Cash Client" }),
    });
    expect(created.status).toBe(201);
    const oldToken = /token=([A-Za-z0-9_-]{43})/.exec(created.json.link)![1];

    await env.DB.prepare("UPDATE onboarding_sessions SET token_expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await req("/api/session", { headers: auth(oldToken) })).status).toBe(410);
    await runScheduled(env);
    const st: any = await env.DB.prepare("SELECT status FROM onboarding_sessions").first();
    expect(st.status).toBe("EXPIRED");

    const re = await req("/api/admin/sessions/ZP-CASH-1/reissue", { method: "POST", headers: auth(ADMIN) });
    expect(re.status).toBe(200);
    const newToken = /token=([A-Za-z0-9_-]{43})/.exec(re.json.link)![1];
    expect((await req("/api/session", { headers: auth(newToken) })).status).toBe(200);
    expect((await req("/api/session", { headers: auth(oldToken) })).status).toBe(401);
  });

  it("wipes client API keys after the purge date", async () => {
    await stripe(paidInvoice());
    const token = tokenFromLastEmail();
    const { json } = await uploadLogo(token, fakePng(1600, 6));
    await req("/api/onboarding/submit", {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify(goodPayload(json.key)),
    });
    await Promise.all(pending);

    const launched = await req("/api/admin/sessions/ZP-2026-014/launched", { method: "POST", headers: auth(ADMIN) });
    expect(launched.status).toBe(200);
    // Not yet: purge date is 7 days out.
    await runScheduled(env);
    let row: any = await env.DB.prepare("SELECT encrypted_secrets_blob FROM onboarding_sessions").first();
    expect(row.encrypted_secrets_blob).toBeTruthy();

    await env.DB.prepare("UPDATE onboarding_sessions SET secrets_purge_after = '2000-01-01T00:00:00.000Z'").run();
    const summary = await runScheduled(env);
    expect(summary.secretsPurged).toBe(1);
    row = await env.DB.prepare("SELECT encrypted_secrets_blob, secrets_iv, secrets_purged_at FROM onboarding_sessions").first();
    expect(row.encrypted_secrets_blob).toBeNull();
    expect(row.secrets_iv).toBeNull();
    expect(row.secrets_purged_at).toBeTruthy();
  });

  it("CORS only answers the portal's own origin", async () => {
    const good = await req("/api/health", { headers: { Origin: "https://intake.test" } });
    expect(good.headers.get("Access-Control-Allow-Origin")).toBe("https://intake.test");
    const evil = await req("/api/health", { headers: { Origin: "https://evil.test" } });
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("Slack alerts", () => {
  const HOOK = (name: string) => `https://hooks.slack.com/services/T000/B000/${name}`;
  const posts = (name: string) => slack.filter((p) => p.url === HOOK(name));
  const allText = (p: { body: any }) => JSON.stringify(p.body);

  beforeEach(() => {
    env.SLACK_WEBHOOK_REVENUE = HOOK("revenue");
    env.SLACK_WEBHOOK_SPRINT_OPS = HOOK("sprint");
    env.SLACK_WEBHOOK_APPROVALS = HOOK("approvals");
    env.SLACK_WEBHOOK_ERRORS = HOOK("errors");
  });

  async function paidAndSubmitted() {
    const inv = paidInvoice();
    (inv.data.object as any).amount_paid = 150000;
    (inv.data.object as any).currency = "usd";
    await stripe(inv);
    const token = tokenFromLastEmail();
    const { json } = await uploadLogo(token, fakePng(1600, 6));
    const r = await req("/api/onboarding/submit", {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify(goodPayload(json.key)),
    });
    await Promise.all(pending);
    return { token, r };
  }

  it("posts a paid invoice to #pipeline-revenue once, with the real amount and no intake link", async () => {
    const inv = paidInvoice();
    (inv.data.object as any).amount_paid = 150000;
    (inv.data.object as any).currency = "usd";
    await stripe(inv);
    await Promise.all(pending);
    const token = tokenFromLastEmail();

    expect(posts("revenue")).toHaveLength(1);
    const msg = posts("revenue")[0].body;
    expect(msg.text).toBe("💰 Invoice paid: $1,500.00");
    expect(allText(posts("revenue")[0])).toContain("ZP-2026-014");
    expect(allText(posts("revenue")[0])).not.toContain(token);

    await stripe(inv); // Stripe re-delivers the same event
    await Promise.all(pending);
    expect(posts("revenue")).toHaveLength(1);
  });

  it("a Slack outage never breaks the Stripe webhook", async () => {
    slackStatus = 500;
    const r = await stripe(paidInvoice());
    await Promise.all(pending);
    expect(r.status).toBe(200);
    expect(r.json.session).toBe("created");
    expect(posts("revenue")).toHaveLength(1);
  });

  it("posts the sprint clock and the Jira epic link to #sprint-ops", async () => {
    const { token } = await paidAndSubmitted();
    const sprint = posts("sprint");
    expect(sprint.map((p) => p.body.text)).toEqual([
      "🚀 Sprint clock running: ZP-2026-014",
      "🗂️ Jira epic ready: ZP-2026-014",
    ]);
    const jiraPost = allText(sprint[1]);
    expect(jiraPost).toContain("https://zinkpress.atlassian.net/browse/ZP-1");
    expect(allText(sprint[0])).not.toContain(token);
    expect(allText(sprint[0])).not.toContain("supersecret");
  });

  it("alerts #worker-errors once when a kickoff follow-up keeps failing", async () => {
    jira = fakeJira({ failBulkOnce: true });
    await paidAndSubmitted();
    expect(posts("errors")).toHaveLength(1);
    expect(posts("errors")[0].body.text).toContain("Kickoff follow-up failed");
  });

  it("alerts #worker-errors on a 500, and the caller still gets its normal answer", async () => {
    const realDb = env.DB;
    env.DB = { prepare: () => { throw new Error("D1 is down"); } } as unknown as D1Database;
    const r = await req("/api/session", { headers: auth("x".repeat(43)) });
    env.DB = realDb;
    await Promise.all(pending);
    expect(r.status).toBe(500);
    expect(posts("errors")).toHaveLength(1);
    expect(posts("errors")[0].body.text).toBe("🔴 Worker error: GET /api/session");
    expect(allText(posts("errors")[0])).toContain("D1 is down");
  });

  it("skips quietly when no webhook URLs are set", async () => {
    delete env.SLACK_WEBHOOK_REVENUE;
    delete env.SLACK_WEBHOOK_SPRINT_OPS;
    delete env.SLACK_WEBHOOK_ERRORS;
    await paidAndSubmitted();
    expect(slack).toHaveLength(0);
  });
});

describe("8 AM workload check", () => {
  const HOOK = "https://hooks.slack.com/services/T000/B000/sprint";
  // 8:17 AM Eastern on Tue Dec 1 2026 (EST, UTC-5).
  const at817 = new Date("2026-12-01T13:17:00.000Z");
  const capture = (async (u: RequestInfo | URL, i: RequestInit = {}) => {
    slack.push({ url: String(u), body: JSON.parse(String(i.body)) });
    return new Response("ok");
  }) as typeof fetch;

  beforeEach(() => {
    env.SLACK_WEBHOOK_SPRINT_OPS = HOOK;
  });

  async function addSession(projectId: string, status: string, sinceIso: string) {
    await env.DB.prepare(
      `INSERT INTO onboarding_sessions (id, project_id, client_name, client_email, tier, status, token_hash, token_expires_at, intake_email_sent_at, guaranteed_deadline)
       VALUES (?, ?, ?, ?, 'TIER_1', ?, ?, '2099-01-01T00:00:00.000Z', ?, '2026-12-03T14:00:00.000Z')`,
    )
      .bind(crypto.randomUUID(), projectId, `Client ${projectId}`, `${projectId}@x.test`, status, crypto.randomUUID(), sinceIso)
      .run();
  }

  it("only runs in the 8 AM Eastern hour, and only once a day", async () => {
    const { runDailyWorkloadCheck } = await import("../src/workload");
    await addSession("ZP-A", "CLOCK_RUNNING", "2026-11-30T12:00:00.000Z");
    await addSession("ZP-B", "CLOCK_RUNNING", "2026-11-30T12:00:00.000Z");
    await addSession("ZP-C", "AWAITING_CREDENTIALS", "2026-11-28T12:00:00.000Z"); // ~73 hours
    await addSession("ZP-D", "AWAITING_CREDENTIALS", "2026-12-01T10:00:00.000Z"); // 3 hours, not stalled

    const at9 = new Date("2026-12-01T14:17:00.000Z");
    expect((await runDailyWorkloadCheck(env, capture, at9)).ran).toBe(false);
    expect(slack).toHaveLength(0);

    const first = await runDailyWorkloadCheck(env, capture, at817);
    expect(first).toMatchObject({ ran: true, activeSprints: 2, stalledClients: 1, posted: ["capacity", "stalled"] });
    expect(slack.map((p) => p.body.text)).toEqual([
      "⚠️ 2 sprints running at once",
      "⏳ 1 paid client stuck on the intake form",
    ]);
    expect(JSON.stringify(slack[1].body)).toContain("ZP-C");
    expect(JSON.stringify(slack[1].body)).not.toContain("ZP-D");

    const again = await runDailyWorkloadCheck(env, capture, new Date("2026-12-01T13:40:00.000Z"));
    expect(again).toMatchObject({ ran: false, reason: "already_posted_today" });
    expect(slack).toHaveLength(2);
  });

  it("stays quiet when there's nothing to report", async () => {
    const { runDailyWorkloadCheck } = await import("../src/workload");
    await addSession("ZP-A", "CLOCK_RUNNING", "2026-11-30T12:00:00.000Z");
    const r = await runDailyWorkloadCheck(env, capture, at817);
    expect(r).toMatchObject({ ran: true, posted: [] });
    expect(slack).toHaveLength(0);
  });
});
