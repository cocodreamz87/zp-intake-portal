import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  buildIntakeSchema,
  flattenIssues,
  isWebmail,
  LAUNCH_SIGNOFF_TEXT,
  loomEmbedUrl,
  needsBusinessCheck,
  SECRET_KEY_RE,
  TIERS,
  type ApproveResult,
  type IntakePayload,
  type ReviewView,
  type SessionView,
  type SubmitResult,
  type Tier,
} from "@zinkpress/shared";
import { encryptJson, timingSafeEqual, TOKEN_RE } from "./crypto";
import { TESTIMONIAL_QUOTE_MAX, TESTIMONIAL_QUOTE_MIN, type MaintenanceView, type TestimonialRequestView } from "@zinkpress/shared";
import {
  addDaysIso,
  audit,
  createSession,
  findSessionByProject,
  findSessionByToken,
  isTokenLive,
  nowIso,
  parseJson,
  reissueToken,
  type SessionRow,
} from "./db";
import { archiveSignedContract, contractCard, draftAndRequestApproval, markLandingComplete } from "./contract-flow";
import { contractStatusFor, pandadocConfigured, sendContract, verifyPandadocSignature } from "./contracts";
import { formatInZone, intakeLinkEmail, reviewReadyEmail, sendEmail } from "./email";
import { numberVar, resendConfigured, type Env } from "./env";
import { checkUpload, type UploadKind } from "./files";
import { runPostSubmit, runScheduled } from "./followups";
import { checkGithubAccount } from "./github";
import { calculateSprintSchedule, DEFAULT_TIMEZONE, parseHolidays } from "./schedule";
import { reportingFetch, reportWorkerError } from "./services/errors";
import { formatMoney, sendSlackAlert, tierLabel } from "./services/slack";
import {
  APPROVE_ACTION_ID,
  contractResultMessage,
  updateSlackMessage,
  verifySlackSignature,
} from "./services/slack-interactive";
import { readPaidInvoice, verifyStripeSignature } from "./stripe";
import { statusView } from "./status";
import { createMaintenanceRequest, findMaintenanceByToken, maintenanceLive, type MaintenanceRow } from "./maintenance";
import { approvedTestimonials, findTestimonialByToken, testimonialLink, type TestimonialRow } from "./testimonials";
import { markDealInvoiced, readDealForInvoice } from "./hubspot";
import { maintenanceLinkEmail } from "./email";
import { BUSINESS_DAYS_BY_TIER } from "./schedule";
import { BANK_ONLY_CENTS, createAndSendInvoice, isBankRail, isCardRail, resolvePaymentRails } from "./stripe-api";

/** Outbound fetch. Tests swap this for a fake so nothing real is ever called. */
let outbound: typeof fetch = (...args) => fetch(...args);
export function setOutboundFetch(f: typeof fetch) {
  outbound = f;
}

type AppEnv = { Bindings: Env; Variables: { session: SessionRow; maintenance: MaintenanceRow; testimonial: TestimonialRow } };
const app = new Hono<AppEnv>();

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const MAX_EXTRA_ASSETS = 20;

app.use("/api/*", async (c, next) => {
  const origins = (c.env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  return cors({
    origin: (origin) => (origins.includes(origin) ? origin : null),
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 600,
  })(c, next);
});

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  // Approved testimonials are public and the same for everyone, so zp-landing may cache them briefly.
  c.header("Cache-Control", c.req.path === "/api/testimonials" && c.res.ok ? "public, max-age=300" : "no-store");
});

app.onError((err, c) => {
  console.error(err);
  // Tell #worker-errors. Runs in the background and can't throw, so the
  // caller (Stripe, the wizard) still gets its normal 500 answer.
  const stack = err instanceof Error && err.stack ? err.stack.split("\n").slice(0, 6).join("\n") : String(err);
  waitUntil(
    c,
    reportWorkerError(
      c.env,
      { service: "zp-intake-portal", step: `${c.req.method} ${c.req.path}`, status: 500, detail: stack },
      outbound,
    ),
  );
  return c.json({ error: "Something went wrong on our side. Please try again in a minute." }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true }));

/** outbound, but every non-2xx answer from an outside API is reported to #worker-errors. */
function tracked(c: Context<AppEnv>, projectId?: string | null) {
  return reportingFetch(c.env, outbound, { projectId, defer: (p) => waitUntil(c, p) });
}

/** Where the client's IP comes from on Cloudflare. */
function clientIp(c: Context<AppEnv>) {
  return c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
}

function waitUntil(c: Context<AppEnv>, p: Promise<unknown>) {
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    // No execution context (some test runners): just let it run.
    void p;
  }
}

function sessionView(env: Env, row: SessionRow): SessionView {
  return {
    projectId: row.project_id,
    clientName: row.client_name,
    tier: row.tier,
    status: row.status,
    requiredIntegrations: parseJson<string[]>(row.required_integrations_json, []),
    agencyName: env.AGENCY_NAME,
    agencyEmail: env.AGENCY_EMAIL,
    cloudflareHelpUrl:
      env.CLOUDFLARE_HELP_URL || "https://developers.cloudflare.com/fundamentals/manage-members/manage/",
    timeZone: env.BUSINESS_TIMEZONE || DEFAULT_TIMEZONE,
    tokenExpiresAt: row.token_expires_at,
    clockStartedAt: row.clock_started_at,
    guaranteedDeadline: row.guaranteed_deadline,
    ...businessRules(row),
  };
}

/** Business check (KYB) for this project: Tier 2/3, or $2,500+, unless you overrode the email rule. */
function businessRules(row: SessionRow) {
  const businessCheckRequired = needsBusinessCheck(row.tier, row.amount_cents);
  return { businessCheckRequired, companyEmailRequired: businessCheckRequired && !row.webmail_override };
}

/**
 * Client routes take the link token in the Authorization header
 * ("Bearer <token>"), not in the URL path, so it stays out of request logs.
 */
const requireSession = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!TOKEN_RE.test(token)) return c.json({ error: "This link isn't valid. Use the link from your email." }, 401);
  const row = await findSessionByToken(c.env.DB, token);
  if (!row) return c.json({ error: "This link isn't valid. Use the link from your email." }, 401);
  if (!isTokenLive(row) && row.status === "AWAITING_CREDENTIALS") {
    return c.json({ error: `This link has expired. Email ${c.env.AGENCY_EMAIL} for a fresh one.`, code: "EXPIRED" }, 410);
  }
  if (row.status === "EXPIRED") {
    return c.json({ error: `This link has expired. Email ${c.env.AGENCY_EMAIL} for a fresh one.`, code: "EXPIRED" }, 410);
  }
  c.set("session", row);
  await next();
};

app.get("/api/session", requireSession, (c) => c.json(sessionView(c.env, c.get("session"))));

app.get("/api/github/check", requireSession, async (c) => {
  const result = await checkGithubAccount(c.req.query("name") ?? "", c.env.GITHUB_TOKEN, tracked(c, c.get("session").project_id));
  return c.json(result);
});

/**
 * Upload goes through the Worker into R2 (binding), instead of a presigned URL.
 * Presigned R2 URLs need separate S3-style access keys; going through the
 * Worker needs none, and lets us check the real file bytes before saving.
 */
app.post("/api/assets/upload", requireSession, async (c) => {
  const row = c.get("session");
  if (row.status !== "AWAITING_CREDENTIALS") return c.json({ error: "This intake is already submitted." }, 409);

  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  const kind = (form?.get("kind") ?? "logo") as UploadKind;
  if (!form || !file || typeof file === "string") return c.json({ error: "Choose a file to upload." }, 400);
  if (kind !== "logo" && kind !== "asset") return c.json({ error: "Unknown upload type." }, 400);

  if (kind === "asset") {
    const listed = await c.env.ASSETS_BUCKET.list({ prefix: `${row.project_id}/assets/asset-`, limit: MAX_EXTRA_ASSETS + 1 });
    if (listed.objects.length >= MAX_EXTRA_ASSETS) {
      return c.json({ error: `You can add up to ${MAX_EXTRA_ASSETS} extra brand files.` }, 400);
    }
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkUpload(kind, bytes);
  if (!check.ok) return c.json({ error: check.error }, 422);

  // Never use the client's file name in the storage path.
  const key = `${row.project_id}/assets/${kind}-${crypto.randomUUID()}.${check.ext}`;
  await c.env.ASSETS_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: check.contentType },
    customMetadata: { originalName: (file.name || "upload").slice(0, 200), sessionId: row.id },
  });
  await audit(c.env.DB, row, "asset.uploaded", { key, kind, bytes: bytes.length, note: check.note });
  return c.json({ key, contentType: check.contentType, note: check.note ?? null });
});

app.post("/api/onboarding/submit", requireSession, async (c) => {
  const row = c.get("session");
  const env = c.env;

  if (row.status === "CLOCK_RUNNING" || row.status === "IN_REVIEW" || row.status === "LAUNCHED") {
    // Double-click or a retry after a dropped connection: same answer, no second clock.
    return c.json({ clockStartedAt: row.clock_started_at, guaranteedDeadline: row.guaranteed_deadline } as SubmitResult);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Send the form as JSON." }, 400);

  const required = parseJson<string[]>(row.required_integrations_json, []);
  const parsed = buildIntakeSchema({ tier: row.tier, requiredIntegrations: required, ...businessRules(row) }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Some answers need fixing.", fields: flattenIssues(parsed.error.issues) }, 422);
  }
  const data: IntakePayload = parsed.data;

  // The logo must be a file this project actually uploaded.
  if (!data.logoKey.startsWith(`${row.project_id}/assets/logo-`) || !(await env.ASSETS_BUCKET.head(data.logoKey))) {
    return c.json({ error: "Some answers need fixing.", fields: { logoKey: "Upload your logo again." } }, 422);
  }
  const assetKeys = Array.isArray((body as any).assetKeys)
    ? ((body as any).assetKeys as unknown[])
        .filter((k): k is string => typeof k === "string" && k.startsWith(`${row.project_id}/assets/asset-`))
        .slice(0, MAX_EXTRA_ASSETS)
    : [];

  // Real GitHub lookup. If GitHub itself is down we let the client through and flag it.
  const gh = await checkGithubAccount(data.githubTarget, env.GITHUB_TOKEN, tracked(c, row.project_id));
  if (gh.status === "not_found" || gh.status === "invalid") {
    return c.json(
      { error: "Some answers need fixing.", fields: { githubTarget: "GitHub doesn't have an account with that name." } },
      422,
    );
  }

  let encrypted: { ciphertext: string; iv: string } | null = null;
  if (Object.keys(data.secrets).length > 0) {
    if (!env.SECRETS_ENCRYPTION_KEY) {
      await audit(env.DB, row, "submit.blocked", "SECRETS_ENCRYPTION_KEY is not set");
      return c.json({ error: "We can't accept API keys right now. Please email us; nothing was saved." }, 503);
    }
    for (const k of Object.keys(data.secrets)) if (!SECRET_KEY_RE.test(k)) return c.json({ error: "Bad key name." }, 422);
    encrypted = await encryptJson(data.secrets, env.SECRETS_ENCRYPTION_KEY, row.project_id);
  }

  const submittedAt = new Date();
  const schedule = calculateSprintSchedule(submittedAt, row.tier, {
    timeZone: env.BUSINESS_TIMEZONE || DEFAULT_TIMEZONE,
    holidays: parseHolidays(env.HOLIDAYS),
  });

  const brand = {
    primaryHex: data.primaryHex.toUpperCase(),
    secondaryHex: data.secondaryHex.toUpperCase(),
    font: data.font,
    logoKey: data.logoKey,
    assetKeys,
  };

  // "AND status = 'AWAITING_CREDENTIALS'" means two submits racing each other
  // can only start the clock once.
  const result = await env.DB.prepare(
    `UPDATE onboarding_sessions SET
       status = 'CLOCK_RUNNING',
       registrar_provider = ?, github_target = ?, github_verified = ?,
       brand_config_json = ?, copy_source_url = ?, copy_json = ?, admin_emails_json = ?,
       encrypted_secrets_blob = ?, secrets_iv = ?,
       spoc_name = ?, spoc_email = ?, legal_business_name = ?, ein_or_registration = ?,
       submitted_at = ?, clock_started_at = ?, guaranteed_deadline = ?, updated_at = ?
     WHERE id = ? AND status = 'AWAITING_CREDENTIALS'`,
  )
    .bind(
      data.registrarProvider,
      gh.status === "exists" ? gh.login : data.githubTarget,
      gh.status === "exists" ? 1 : 0,
      JSON.stringify(brand),
      data.copy.mode === "link" ? data.copy.url : null,
      JSON.stringify(data.copy),
      JSON.stringify(data.adminEmails),
      encrypted?.ciphertext ?? null,
      encrypted?.iv ?? null,
      data.spocName,
      data.spocEmail.toLowerCase(),
      data.legalBusinessName || null,
      data.einOrRegistration ? data.einOrRegistration.toUpperCase() : null,
      submittedAt.toISOString(),
      schedule.clockStartedAt,
      schedule.guaranteedDeadline,
      nowIso(),
      row.id,
    )
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    const fresh = await findSessionByProject(env.DB, row.project_id);
    return c.json({ clockStartedAt: fresh?.clock_started_at, guaranteedDeadline: fresh?.guaranteed_deadline });
  }

  await audit(env.DB, row, "clock.started", {
    clockStartedAt: schedule.clockStartedAt,
    guaranteedDeadline: schedule.guaranteedDeadline,
    githubCheck: gh.status,
    secretsStored: Object.keys(data.secrets), // key names only, never values
    businessCheck: { legalBusinessName: Boolean(data.legalBusinessName), einOrRegistration: Boolean(data.einOrRegistration) }, // never the number
  });

  const tz = env.BUSINESS_TIMEZONE || DEFAULT_TIMEZONE;
  waitUntil(
    c,
    sendSlackAlert(
      env,
      {
        channel: "SPRINT_OPS",
        title: `🚀 Sprint clock running: ${row.project_id}`,
        fields: [
          { label: "Client", value: row.client_name },
          { label: "Tier", value: tierLabel(row.tier) },
          { label: "Kickoff", value: formatInZone(schedule.clockStartedAt, tz) },
          { label: "Staging due", value: formatInZone(schedule.guaranteedDeadline, tz) },
          { label: "Point of contact", value: data.spocName },
          { label: "GitHub", value: gh.status === "exists" ? gh.login : `${data.githubTarget} (not verified)` },
        ],
        note: "The Jira epic link follows here once it's created.",
      },
      outbound,
    ),
  );
  waitUntil(c, runPostSubmit(env, row.id, outbound));
  return c.json({ clockStartedAt: schedule.clockStartedAt, guaranteedDeadline: schedule.guaranteedDeadline } as SubmitResult);
});

/* ------------------------------ Stripe ------------------------------ */

/** The intake form's address: PORTAL_URL if set, otherwise this Worker's own address. */
function portalBase(env: Env, requestUrl: string): string {
  return (env.PORTAL_URL?.trim() || new URL(requestUrl).origin).replace(/\/$/, "");
}

async function startIntake(
  env: Env,
  baseUrl: string,
  s: {
    projectId: string;
    clientName: string;
    clientEmail: string;
    tier: Tier;
    requiredIntegrations: string[];
    invoiceId?: string | null;
    contactName?: string | null;
    amountCents?: number | null;
    currency?: string | null;
    paymentRail?: string | null;
    webmailOverride?: boolean;
  },
  fetchImpl: typeof fetch = outbound,
) {
  const ttl = numberVar(env.TOKEN_TTL_DAYS, 14);
  const existing = await findSessionByProject(env.DB, s.projectId);
  let token: string;
  let expiresAt: string;
  let row: Pick<SessionRow, "id" | "project_id">;

  if (existing) {
    // Same project again (Stripe retry, or you re-ran it). If the first email never
    // went out, make a fresh link and try again. Otherwise leave it alone.
    if (existing.intake_email_sent_at || existing.status !== "AWAITING_CREDENTIALS") {
      return { status: "exists" as const, link: null };
    }
    ({ token, expiresAt } = await reissueToken(env.DB, existing, ttl));
    row = existing;
  } else {
    const created = await createSession(env.DB, {
      projectId: s.projectId,
      clientName: s.clientName,
      clientEmail: s.clientEmail,
      tier: s.tier,
      requiredIntegrations: s.requiredIntegrations,
      stripeInvoiceId: s.invoiceId ?? null,
      tokenTtlDays: ttl,
      contactName: s.contactName,
      amountCents: s.amountCents,
      currency: s.currency,
      paymentRail: s.paymentRail,
      webmailOverride: s.webmailOverride,
    });
    ({ token, expiresAt } = created);
    row = { id: created.id, project_id: s.projectId };
    await audit(env.DB, row, "session.created", {
      tier: s.tier,
      invoiceId: s.invoiceId ?? null,
      amountCents: s.amountCents ?? null,
      paymentRail: s.paymentRail ?? null,
    });
    // Business check: Tier 2/3 (or $2,500+) paid from a free mailbox. The intake form will
    // also require the approver to use a company-domain email unless you override it.
    if (needsBusinessCheck(s.tier, s.amountCents) && isWebmail(s.clientEmail) && !s.webmailOverride) {
      await audit(env.DB, row, "kyb.webmail_flagged", { domain: s.clientEmail.split("@")[1] ?? "" });
    }
  }

  const link = `${baseUrl}/?token=${token}`;
  let emailed = false;
  if (resendConfigured(env)) {
    const mail = intakeLinkEmail(env, { clientName: s.clientName, projectId: s.projectId, link, expiresAt });
    await sendEmail(env, { to: s.clientEmail, ...mail, idempotencyKey: `intake-${row.id}-${expiresAt}` }, fetchImpl);
    await env.DB.prepare("UPDATE onboarding_sessions SET intake_email_sent_at = ?, updated_at = ? WHERE id = ?")
      .bind(nowIso(), nowIso(), row.id)
      .run();
    emailed = true;
    await audit(env.DB, row, "intake.emailed", { to: s.clientEmail });
  }
  return { status: "created" as const, link, emailed, expiresAt, sessionId: row.id };
}

function cleanIntegrations(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((s) => String(s).trim().toUpperCase()).filter((s) => SECRET_KEY_RE.test(s)))].slice(0, 25);
}

app.post("/api/stripe/webhook", async (c) => {
  const env = c.env;
  const raw = await c.req.text(); // must be the exact bytes Stripe signed
  const ok = await verifyStripeSignature(raw, c.req.header("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET ?? "");
  if (!ok) return c.json({ error: "bad signature" }, 400);

  const event = JSON.parse(raw);
  const seen = await env.DB.prepare("SELECT 1 AS x FROM stripe_events WHERE event_id = ?").bind(String(event.id)).first();
  if (seen) return c.json({ received: true, duplicate: true });

  const info = readPaidInvoice(event);
  if ("error" in info) {
    // Answer 200 so Stripe stops retrying something that will never work; log it for you.
    if (event.type === "invoice.paid") await audit(env.DB, null, "stripe.ignored", { id: event.id, reason: info.error });
    await env.DB.prepare("INSERT OR IGNORE INTO stripe_events (event_id) VALUES (?)").bind(String(event.id)).run();
    return c.json({ received: true, ignored: info.error });
  }
  if (!PROJECT_ID_RE.test(info.projectId) || !TIERS.includes(info.tier as Tier)) {
    await audit(env.DB, null, "stripe.ignored", { id: event.id, reason: "bad project_id or tier", info });
    await env.DB.prepare("INSERT OR IGNORE INTO stripe_events (event_id) VALUES (?)").bind(info.eventId).run();
    return c.json({ received: true, ignored: "bad project_id or tier" });
  }

  const f = tracked(c, info.projectId);
  const markDone = () => env.DB.prepare("INSERT OR IGNORE INTO stripe_events (event_id) VALUES (?)").bind(info.eventId).run();

  // $500+ = bank transfer only (ACH / wire / Stripe cash balance). A card must never unlock the intake.
  const amount = info.amountPaid ?? 0;
  let paymentRail: string | null = null;
  if (amount >= BANK_ONLY_CENTS) {
    const rails = await resolvePaymentRails(env, info.invoice, f);
    if (!rails.ok) {
      // Can't tell how it was paid (no STRIPE_SECRET_KEY yet, or Stripe is down). Hold it:
      // answer 503 so Stripe retries this event later, and tell #worker-errors.
      await audit(env.DB, null, "stripe.rail_unverified", { id: event.id, projectId: info.projectId, reason: rails.reason });
      waitUntil(
        c,
        reportWorkerError(
          env,
          {
            service: "Stripe",
            step: "payment rail check ($500+ bank-only rule)",
            projectId: info.projectId,
            status: rails.reason,
            detail:
              rails.reason === "no_api_key"
                ? `Invoice ${info.invoiceId} (${formatMoney(amount, info.currency)}) can't be checked: STRIPE_SECRET_KEY isn't set. The intake stays locked; Stripe will retry.`
                : `Invoice ${info.invoiceId}: ${rails.detail ?? rails.reason}. The intake stays locked; Stripe will retry.`,
          },
          outbound,
        ),
      );
      return c.json({ received: false, held: "payment_rail_unverified" }, 503);
    }
    const blocked = rails.rails.filter((r) => !isBankRail(r));
    if (blocked.length) {
      const card = blocked.some(isCardRail);
      const event_name = card ? "stripe.blocked_card_over_500" : "stripe.blocked_rail_over_500";
      await audit(env.DB, null, event_name, {
        id: event.id,
        projectId: info.projectId,
        invoiceId: info.invoiceId,
        amountCents: amount,
        rails: rails.rails,
      });
      await markDone();
      waitUntil(
        c,
        reportWorkerError(
          env,
          {
            service: "Stripe",
            step: card ? "card payment on a $500+ invoice" : "non-bank payment on a $500+ invoice",
            projectId: info.projectId,
            status: "blocked",
            detail:
              `Invoice ${info.invoiceId} for ${info.clientName} was paid ${formatMoney(amount, info.currency)} by ${rails.rails.join(", ")}. ` +
              "The intake link was NOT sent. Refund it in Stripe and re-issue the invoice for ACH or wire (POST /api/admin/invoices).",
          },
          outbound,
        ),
      );
      return c.json({ received: true, blocked: event_name });
    }
    paymentRail = rails.rails.join(",");
  }

  // If this throws (for example the email fails), we answer 500 and Stripe retries later.
  const result = await startIntake(
    env,
    portalBase(env, c.req.url),
    {
      projectId: info.projectId,
      clientName: info.clientName,
      clientEmail: info.clientEmail,
      tier: info.tier as Tier,
      requiredIntegrations: cleanIntegrations(info.requiredIntegrations),
      invoiceId: info.invoiceId,
      contactName: info.contactName,
      amountCents: info.amountPaid,
      currency: info.currency,
      paymentRail,
    },
    f,
  );
  if (info.hubspotDealId) {
    // Remember the scoping deal so zp-landing closes it instead of making a second one.
    await env.DB.prepare("UPDATE onboarding_sessions SET hubspot_deal_id = ? WHERE project_id = ? AND hubspot_deal_id IS NULL")
      .bind(info.hubspotDealId, info.projectId)
      .run();
  }
  if (result.status === "created" && pandadocConfigured(env)) {
    // Contract: populate the PandaDoc draft and ask #contract-approvals to approve it.
    waitUntil(
      c,
      draftAndRequestApproval(env, result.sessionId, f).catch((err) =>
        console.error("contract draft failed (the hourly job retries):", err instanceof Error ? err.message : err),
      ),
    );
  }
  await env.DB.prepare("INSERT OR IGNORE INTO stripe_events (event_id) VALUES (?)").bind(info.eventId).run();

  // Only for a new intake, so a re-sent invoice doesn't post twice.
  // Never include the intake link: it works like a password for the client.
  if (result.status === "created") {
    waitUntil(
      c,
      sendSlackAlert(
        env,
        {
          channel: "REVENUE",
          title: `💰 Invoice paid: ${formatMoney(info.amountPaid, info.currency)}`,
          fields: [
            { label: "Client", value: info.clientName },
            { label: "Project", value: info.projectId },
            { label: "Tier", value: tierLabel(info.tier) },
            { label: "Amount", value: formatMoney(info.amountPaid, info.currency) },
            { label: "Paid by", value: paymentRail ?? "under $500 (any method)" },
            { label: "Intake link", value: result.emailed ? `Emailed to ${info.clientEmail}` : "Not emailed (Resend isn't set up)" },
            { label: "Stripe invoice", value: info.invoiceId },
          ],
        },
        outbound,
      ),
    );
  }
  return c.json({ received: true, session: result.status });
});

/* ------------------------------ Admin (you) ------------------------------ */

const requireAdmin = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  const want = c.env.ADMIN_API_TOKEN;
  const got = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!want || want.length < 24 || !timingSafeEqual(got, want)) return c.json({ error: "unauthorized" }, 401);
  await next();
};

/** Start an intake by hand (no Stripe), e.g. for a cash or Zelle client, or to test. */
app.post("/api/admin/sessions", requireAdmin, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const projectId = String(b.projectId ?? "").trim();
  const tier = String(b.tier ?? "").trim().toUpperCase() as Tier;
  const clientEmail = String(b.clientEmail ?? "").trim();
  const clientName = String(b.clientName ?? clientEmail).trim();
  if (!PROJECT_ID_RE.test(projectId)) return c.json({ error: "projectId: letters, numbers, dot, dash, underscore" }, 400);
  if (!TIERS.includes(tier)) return c.json({ error: "tier must be TIER_1, TIER_2 or TIER_3" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clientEmail)) return c.json({ error: "clientEmail is not an email" }, 400);
  if (await findSessionByProject(c.env.DB, projectId)) return c.json({ error: "That project already has an intake." }, 409);
  const result = await startIntake(c.env, portalBase(c.env, c.req.url), {
    projectId,
    clientName,
    clientEmail,
    tier,
    requiredIntegrations: cleanIntegrations(b.requiredIntegrations),
  });
  return c.json(result, 201);
});

app.get("/api/admin/sessions/:projectId", requireAdmin, async (c) => {
  const row = await findSessionByProject(c.env.DB, c.req.param("projectId") ?? "");
  if (!row) return c.json({ error: "not found" }, 404);
  const { token_hash, encrypted_secrets_blob, secrets_iv, ein_or_registration, ...safe } = row;
  const log = await c.env.DB.prepare(
    "SELECT event, detail, created_at FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT 50",
  )
    .bind(row.project_id)
    .all();
  return c.json({
    ...safe,
    // Only the last 4 characters of the EIN/registration number, so it isn't copied around.
    ein_or_registration_last4: ein_or_registration ? ein_or_registration.slice(-4) : null,
    has_encrypted_secrets: Boolean(encrypted_secrets_blob),
    pandadoc_url: row.pandadoc_document_id ? `https://app.pandadoc.com/a/#/documents/${row.pandadoc_document_id}` : null,
    audit: log.results,
  });
});

/** New link for a client who lost theirs or let it expire. The old link stops working. */
app.post("/api/admin/sessions/:projectId/reissue", requireAdmin, async (c) => {
  const row = await findSessionByProject(c.env.DB, c.req.param("projectId") ?? "");
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "AWAITING_CREDENTIALS" && row.status !== "EXPIRED") {
    return c.json({ error: "Already submitted; no new link needed." }, 409);
  }
  const { token, expiresAt } = await reissueToken(c.env.DB, row, numberVar(c.env.TOKEN_TTL_DAYS, 14));
  const link = `${portalBase(c.env, c.req.url)}/?token=${token}`;
  let emailed = false;
  if (resendConfigured(c.env)) {
    const mail = intakeLinkEmail(c.env, { clientName: row.client_name, projectId: row.project_id, link, expiresAt });
    await sendEmail(c.env, { to: row.client_email, ...mail, idempotencyKey: `intake-${row.id}-${expiresAt}` }, outbound);
    emailed = true;
  }
  await audit(c.env.DB, row, "link.reissued", { emailed });
  return c.json({ link, expiresAt, emailed });
});

/** Mark the site launched. Client API keys are wiped SECRETS_PURGE_DAYS (default 7) days later. */
app.post("/api/admin/sessions/:projectId/launched", requireAdmin, async (c) => {
  const row = await findSessionByProject(c.env.DB, c.req.param("projectId") ?? "");
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "CLOCK_RUNNING" && row.status !== "IN_REVIEW" && row.status !== "LAUNCHED") return c.json({ error: "Not started yet." }, 409);
  const purgeAfter = addDaysIso(numberVar(c.env.SECRETS_PURGE_DAYS, 7));
  await c.env.DB.prepare(
    "UPDATE onboarding_sessions SET status = 'LAUNCHED', launched_at = COALESCE(launched_at, ?), secrets_purge_after = COALESCE(secrets_purge_after, ?), updated_at = ? WHERE id = ?",
  )
    .bind(nowIso(), purgeAfter, nowIso(), row.id)
    .run();
  await audit(c.env.DB, row, "launched", { secretsPurgeAfter: purgeAfter });
  return c.json({ status: "LAUNCHED", secretsPurgeAfter: row.secrets_purge_after ?? purgeAfter });
});


/* ------------------------------ Invoices ($500+ = bank only) ------------------------------ */

/**
 * Create and send a Stripe invoice with the project metadata filled in.
 * At $500+ the invoice only offers us_bank_account (ACH) and customer_balance (bank transfer / wire).
 */
app.post("/api/admin/invoices", requireAdmin, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  return issueInvoice(c, b, null);
});

/** Validates the invoice fields and makes the Stripe invoice. Shared by /api/admin/invoices and /from-deal. */
async function issueInvoice(c: Context<AppEnv>, b: Record<string, unknown>, hubspotDealId: string | null) {
  const env = c.env;
  if (!env.STRIPE_SECRET_KEY) return c.json({ error: "Add the STRIPE_SECRET_KEY secret first." }, 503);
  const projectId = String(b.projectId ?? b.project_id ?? "").trim();
  const tier = String(b.tier ?? "").trim().toUpperCase() as Tier;
  const companyName = String(b.companyName ?? b.company_name ?? "").trim();
  const contactName = String(b.contactName ?? b.contact_name ?? companyName).trim();
  const contactEmail = String(b.contactEmail ?? b.contact_email ?? "").trim().toLowerCase();
  const amountCents = Number(b.amountCents ?? b.amount);
  const currency = String(b.currency ?? "usd").trim().toLowerCase();
  const milestone = String(b.milestone ?? "deposit").trim().toLowerCase();
  const daysUntilDue = Number(b.daysUntilDue ?? 7);
  if (!PROJECT_ID_RE.test(projectId)) return c.json({ error: "projectId: letters, numbers, dot, dash, underscore" }, 400);
  if (!TIERS.includes(tier)) return c.json({ error: "tier must be TIER_1, TIER_2 or TIER_3" }, 400);
  if (companyName.length < 2) return c.json({ error: "companyName is required" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contactEmail)) return c.json({ error: "contactEmail is not an email" }, 400);
  if (!Number.isInteger(amountCents) || amountCents < 100) return c.json({ error: "amountCents must be a whole number of cents, e.g. 150000 for $1,500" }, 400);
  if (currency !== "usd") return c.json({ error: "Only usd invoices are supported (ACH and US bank transfer are USD-only)." }, 400);
  if (!/^[a-z0-9_-]{1,32}$/.test(milestone)) return c.json({ error: "milestone: e.g. deposit, final" }, 400);
  if (!Number.isInteger(daysUntilDue) || daysUntilDue < 1 || daysUntilDue > 90) return c.json({ error: "daysUntilDue: 1 to 90" }, 400);
  const out = await createAndSendInvoice(
    env,
    {
      projectId,
      tier,
      companyName,
      contactName,
      contactEmail,
      integrations: cleanIntegrations(b.integrations),
      amountCents,
      currency,
      description: String(b.description ?? `${env.AGENCY_NAME} ${tierLabel(tier)} · ${projectId} (${milestone})`).slice(0, 500),
      daysUntilDue,
      milestone,
      send: b.send !== false,
      hubspotDealId,
    },
    tracked(c, projectId),
  );
  await audit(env.DB, null, "invoice.created", {
    projectId,
    invoiceId: out.invoiceId,
    amountCents,
    bankOnly: amountCents >= BANK_ONLY_CENTS,
    sent: out.sent,
    hubspotDealId,
  });
  return c.json({ ...out, projectId, tier, amountCents, bankOnly: amountCents >= BANK_ONLY_CENTS }, 201);
}

/** Let a Tier 2/3 approver use a gmail/yahoo/... address for this one project. */
app.post("/api/admin/sessions/:projectId/kyb-override", requireAdmin, async (c) => {
  const row = await findSessionByProject(c.env.DB, c.req.param("projectId") ?? "");
  if (!row) return c.json({ error: "not found" }, 404);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const allow = b.allowWebmail !== false;
  const reason = String(b.reason ?? "").trim().slice(0, 300);
  if (allow && reason.length < 3) return c.json({ error: "Say why in reason, e.g. \"sole proprietor, no company domain\"." }, 400);
  await c.env.DB.prepare("UPDATE onboarding_sessions SET webmail_override = ?, webmail_override_reason = ?, updated_at = ? WHERE id = ?")
    .bind(allow ? 1 : 0, allow ? reason : null, nowIso(), row.id)
    .run();
  await audit(c.env.DB, row, "kyb.override", { allowWebmail: allow, reason });
  return c.json({ projectId: row.project_id, allowWebmail: allow });
});

/* ------------------------------ Contracts (PandaDoc) ------------------------------ */

/** Make the PandaDoc draft now (normally automatic on invoice.paid) and post it for approval. */
app.post("/api/contracts/draft", requireAdmin, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const row = await findSessionByProject(c.env.DB, String(b.projectId ?? b.project_id ?? ""));
  if (!row) return c.json({ error: "not found" }, 404);
  if (!pandadocConfigured(c.env)) return c.json({ error: "Add PANDADOC_API_KEY and PANDADOC_TEMPLATE_ID first." }, 503);
  const out = await draftAndRequestApproval(c.env, row.id, tracked(c, row.project_id));
  return c.json(out, out.status === "drafted" ? 201 : 200);
});

/** Fallback for the Slack button: send the approved draft to the client. */
app.post("/api/admin/sessions/:projectId/send-contract", requireAdmin, async (c) => {
  const row = await findSessionByProject(c.env.DB, c.req.param("projectId") ?? "");
  if (!row) return c.json({ error: "not found" }, 404);
  const out = await sendContract(c.env, row, "admin API", tracked(c, row.project_id));
  if (out.status === "sent") return c.json({ ...out, contractStatus: "SENT" });
  return c.json(out, out.status === "already" ? 409 : 425);
});

/**
 * Slack interactivity (the Approve & Send Contract button).
 * Set as the Slack app's Interactivity Request URL. Slack needs an answer within 3 seconds,
 * so we answer 200 at once and do the send in the background.
 */
app.post("/api/slack/interactions", async (c) => {
  const env = c.env;
  const raw = await c.req.text();
  const ok = await verifySlackSignature(raw, c.req.header("X-Slack-Request-Timestamp"), c.req.header("X-Slack-Signature"), env.SLACK_SIGNING_SECRET);
  if (!ok) return c.json({ error: "bad signature" }, 401);

  let payload: any = null;
  try {
    payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "null");
  } catch {
    payload = null;
  }
  const action = payload?.type === "block_actions" ? (payload.actions ?? []).find((a: any) => a?.action_id === APPROVE_ACTION_ID) : null;
  if (!action) return c.body(null, 200);

  const userId = String(payload.user?.id ?? "");
  const approver = `${payload.user?.name || payload.user?.username || "someone"} (${userId || "no id"})`;
  const responseUrl = String(payload.response_url ?? "");
  const projectId = String(action.value ?? "");
  const allowed = (env.SLACK_CONTRACT_APPROVERS || "").split(",").map((s) => s.trim()).filter(Boolean);

  waitUntil(
    c,
    (async () => {
      const row = await findSessionByProject(env.DB, projectId);
      if (!row || !row.pandadoc_document_id) return;
      const card = contractCard(row);
      if (allowed.length && !allowed.includes(userId)) {
        await audit(env.DB, row, "contract.approval_refused", { approver });
        await updateSlackMessage(responseUrl, contractResultMessage(card, { ok: false, approver, reason: "you're not on the approver list." }), outbound);
        return;
      }
      try {
        const out = await sendContract(env, row, `Slack: ${approver}`, tracked(c, row.project_id));
        const at = formatInZone(nowIso(), env.BUSINESS_TIMEZONE || DEFAULT_TIMEZONE);
        if (out.status === "sent") {
          await updateSlackMessage(responseUrl, contractResultMessage(card, { ok: true, approver, at }), outbound);
        } else if (out.status === "already") {
          await updateSlackMessage(
            responseUrl,
            contractResultMessage(card, { ok: false, approver, reason: `it was already ${String(out.contractStatus ?? "handled").toLowerCase()}.` }),
            outbound,
          );
        } else {
          await updateSlackMessage(responseUrl, contractResultMessage(card, { ok: false, approver, reason: out.reason }), outbound);
        }
      } catch (err) {
        await updateSlackMessage(
          responseUrl,
          contractResultMessage(card, { ok: false, approver, reason: "PandaDoc returned an error (details in #worker-errors)." }),
          outbound,
        );
        console.error("contract send failed:", err instanceof Error ? err.message : err);
      }
    })(),
  );
  return c.body(null, 200);
});

/**
 * PandaDoc webhook: Settings > Webhooks, URL <portal>/api/pandadoc/webhook, event
 * "Document state changed", shared key = PANDADOC_WEBHOOK_KEY. PandaDoc adds ?signature=.
 */
app.post("/api/pandadoc/webhook", async (c) => {
  const env = c.env;
  const raw = await c.req.text();
  if (!(await verifyPandadocSignature(raw, c.req.query("signature"), env.PANDADOC_WEBHOOK_KEY))) {
    return c.json({ error: "bad signature" }, 401);
  }
  let events: any[] = [];
  try {
    const parsed = JSON.parse(raw);
    events = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return c.json({ error: "bad json" }, 400);
  }
  const handled: Array<{ documentId: string; status: string }> = [];
  for (const ev of events) {
    if (ev?.event !== "document_state_changed") continue;
    const documentId = String(ev.data?.id ?? "");
    const next = contractStatusFor(String(ev.data?.status ?? ""));
    if (!documentId || !next) continue;
    const row = await env.DB.prepare("SELECT * FROM onboarding_sessions WHERE pandadoc_document_id = ?").bind(documentId).first<SessionRow>();
    if (!row) continue;
    if (row.contract_status === "SIGNED" && next !== "SIGNED") continue; // never move back from signed
    const at = nowIso();
    if (next === "SIGNED") {
      await env.DB.prepare(
        "UPDATE onboarding_sessions SET contract_status = 'SIGNED', contract_signed_at = COALESCE(contract_signed_at, ?), updated_at = ? WHERE id = ?",
      )
        .bind(at, at, row.id)
        .run();
      if (row.contract_status !== "SIGNED") {
        await audit(env.DB, row, "contract.signed", { documentId });
        waitUntil(
          c,
          sendSlackAlert(
            env,
            {
              channel: "CONTRACTS",
              title: `🖊️ Contract signed: ${row.project_id}`,
              fields: [
                { label: "Client", value: row.legal_business_name || row.client_name },
                { label: "Signed", value: formatInZone(at, env.BUSINESS_TIMEZONE || DEFAULT_TIMEZONE) },
              ],
              note: "The signed PDF is being saved to R2 and the client's Drive (01_Contracts_and_Scope).",
            },
            outbound,
          ),
        );
      }
      waitUntil(
        c,
        archiveSignedContract(env, row.id, tracked(c, row.project_id)).catch((err) =>
          console.error("signed contract archive failed (the hourly job retries):", err instanceof Error ? err.message : err),
        ),
      );
    } else if (row.contract_status !== next && row.contract_status !== "SENDING") {
      await env.DB.prepare("UPDATE onboarding_sessions SET contract_status = ?, updated_at = ? WHERE id = ?").bind(next, at, row.id).run();
      await audit(env.DB, row, `contract.${next.toLowerCase()}`, { documentId, pandadocStatus: ev.data?.status });
      if (next === "DECLINED" || next === "VOIDED") {
        waitUntil(
          c,
          sendSlackAlert(
            env,
            { channel: "CONTRACTS", title: `⚠️ Contract ${next.toLowerCase()}: ${row.project_id}`, fields: [{ label: "Client", value: row.client_name }] },
            outbound,
          ),
        );
      }
    }
    handled.push({ documentId, status: next });
  }
  return c.json({ received: true, handled });
});

/* ------------------------------ Staging review + launch sign-off ------------------------------ */

function httpsOrNull(v: unknown, max = 2000): string | null {
  const s = String(v ?? "").trim();
  if (!s || s.length > max) return null;
  try {
    return new URL(s).protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

/**
 * Staging is ready: save the links and notes, set status IN_REVIEW, and send the client a
 * private review link (/review?token=...). This issues a new link token; the old intake
 * link stops working (its form is already submitted).
 */
app.post("/api/admin/sessions/:projectId/ready-for-review", requireAdmin, async (c) => {
  const env = c.env;
  const row = await findSessionByProject(env.DB, c.req.param("projectId") ?? "");
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "CLOCK_RUNNING" && row.status !== "IN_REVIEW") {
    return c.json({ error: row.status === "LAUNCHED" ? "Already launched." : "The intake isn't submitted yet." }, 409);
  }
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const stagingUrl = httpsOrNull(b.stagingUrl);
  const loomUrl = httpsOrNull(b.loomUrl);
  const releaseNotes = String(b.releaseNotes ?? "").trim();
  if (!stagingUrl) return c.json({ error: "stagingUrl must be a full https:// link" }, 400);
  if (!loomUrl || !loomEmbedUrl(loomUrl)) return c.json({ error: "loomUrl must be a Loom share link, like https://www.loom.com/share/<id>" }, 400);
  if (releaseNotes.length < 3 || releaseNotes.length > 10_000) return c.json({ error: "releaseNotes: 3 to 10,000 characters" }, 400);

  const ttl = numberVar(env.TOKEN_TTL_DAYS, 14);
  const { token, expiresAt } = await reissueToken(env.DB, row, ttl);
  const at = nowIso();
  await env.DB.prepare(
    `UPDATE onboarding_sessions SET status = 'IN_REVIEW', staging_url = ?, loom_url = ?, release_notes = ?,
       review_requested_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(stagingUrl, loomUrl, releaseNotes, at, at, row.id)
    .run();
  const link = `${portalBase(env, c.req.url)}/review?token=${token}`;
  const f = tracked(c, row.project_id);

  let emailed: string[] = [];
  if (resendConfigured(env)) {
    const mail = reviewReadyEmail(env, { clientName: row.client_name, projectId: row.project_id, link, stagingUrl, expiresAt });
    const to = [row.spoc_email, row.client_email].filter((e, i, a): e is string => !!e && a.indexOf(e) === i);
    for (const addr of to) await sendEmail(env, { to: addr, ...mail, idempotencyKey: `review-${row.id}-${expiresAt}-${addr}` }, f);
    emailed = to;
  }
  await audit(env.DB, row, "review.requested", { stagingUrl, loomUrl, emailed });
  // #staging-approvals gets the review link too, so you can pass it on while email isn't set up.
  // Treat it like a password: whoever has it can sign off the launch.
  waitUntil(
    c,
    sendSlackAlert(
      env,
      {
        channel: "APPROVALS",
        title: `👀 Staging ready for client review: ${row.project_id}`,
        fields: [
          { label: "Client", value: row.client_name },
          { label: "Approver", value: `${row.spoc_name ?? ""} ${row.spoc_email ? `(${row.spoc_email})` : ""}`.trim() || row.client_email },
          { label: "Review link emailed", value: emailed.length ? emailed.join(", ") : "No (Resend isn't set up). Send the link yourself." },
          { label: "Link works until", value: formatInZone(expiresAt, env.BUSINESS_TIMEZONE || DEFAULT_TIMEZONE) },
        ],
        note: `Private client review link (works like a password, don't forward it to anyone but the client):\n${link}`,
        links: [
          { label: "Open staging", url: stagingUrl },
          { label: "Loom walkthrough", url: loomUrl },
        ],
      },
      outbound,
    ),
  );
  return c.json({ status: "IN_REVIEW", link, expiresAt, emailed });
});

function reviewView(env: Env, row: SessionRow): ReviewView {
  return {
    projectId: row.project_id,
    clientName: row.client_name,
    tier: row.tier,
    status: row.status,
    agencyName: env.AGENCY_NAME,
    agencyEmail: env.AGENCY_EMAIL,
    stagingUrl: row.staging_url,
    loomUrl: row.loom_url,
    loomEmbedUrl: loomEmbedUrl(row.loom_url),
    releaseNotes: row.release_notes,
    reviewRequestedAt: row.review_requested_at,
    approvedAt: row.client_approved_at,
    approvedBy: row.client_approval_name,
  };
}

/** Review routes need a live link and a project that's in review (or already signed off). */
const requireReview = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  const row = c.get("session");
  if (row.status !== "IN_REVIEW" && row.status !== "LAUNCHED") return c.json({ error: "There's nothing to review yet." }, 409);
  if (row.status === "IN_REVIEW" && !isTokenLive(row)) {
    return c.json({ error: `This review link has expired. Email ${c.env.AGENCY_EMAIL} for a fresh one.`, code: "EXPIRED" }, 410);
  }
  await next();
};

app.get("/api/review", requireSession, requireReview, (c) => c.json(reviewView(c.env, c.get("session"))));

/**
 * The client's launch sign-off. Records their typed name, IP and the exact sign-off text,
 * sets LAUNCHED, and schedules the client API keys to be wiped SECRETS_PURGE_DAYS (7) days later.
 */
app.post("/api/review/approve", requireSession, requireReview, async (c) => {
  const env = c.env;
  const row = c.get("session");
  if (row.status === "LAUNCHED") {
    return c.json({ status: "LAUNCHED", approvedAt: row.client_approved_at ?? row.launched_at ?? nowIso() } as ApproveResult);
  }
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = String(b.signerName ?? "").trim();
  const fields: Record<string, string> = {};
  if (b.confirmed !== true) fields.confirmed = "Tick the box to approve the launch.";
  if (name.length < 2 || name.length > 120) fields.signerName = "Type your full name.";
  if (Object.keys(fields).length) return c.json({ error: "Some answers need fixing.", fields }, 422);

  const at = nowIso();
  const ip = clientIp(c);
  const purgeAfter = addDaysIso(numberVar(env.SECRETS_PURGE_DAYS, 7));
  const result = await env.DB.prepare(
    `UPDATE onboarding_sessions SET status = 'LAUNCHED', launched_at = COALESCE(launched_at, ?),
       secrets_purge_after = COALESCE(secrets_purge_after, ?), client_approved_at = ?, client_approval_ip = ?,
       client_approval_name = ?, updated_at = ?
     WHERE id = ? AND status = 'IN_REVIEW'`,
  )
    .bind(at, purgeAfter, at, ip, name, at, row.id)
    .run();
  if ((result.meta?.changes ?? 0) === 0) {
    const fresh = await findSessionByProject(env.DB, row.project_id);
    return c.json({ status: "LAUNCHED", approvedAt: fresh?.client_approved_at ?? at } as ApproveResult);
  }
  await audit(env.DB, row, "review.approved", {
    signerName: name,
    ip,
    at,
    userAgent: (c.req.header("User-Agent") ?? "").slice(0, 300),
    signoffText: LAUNCH_SIGNOFF_TEXT,
    stagingUrl: row.staging_url,
    secretsPurgeAfter: purgeAfter,
  });
  waitUntil(
    c,
    sendSlackAlert(
      env,
      {
        channel: "APPROVALS",
        title: `🚀 Client approved launch: ${row.project_id}`,
        fields: [
          { label: "Client", value: row.client_name },
          { label: "Signed off by", value: name },
          { label: "When", value: formatInZone(at, env.BUSINESS_TIMEZONE || DEFAULT_TIMEZONE) },
          { label: "From IP", value: ip },
          { label: "Client keys wiped", value: formatInZone(purgeAfter, env.BUSINESS_TIMEZONE || DEFAULT_TIMEZONE) },
        ],
        note: "Status is LAUNCHED. Push the production cutover.",
        links: row.staging_url ? [{ label: "Open staging", url: row.staging_url }] : [],
      },
      outbound,
    ),
  );
  waitUntil(
    c,
    markLandingComplete(env, row.id, tracked(c, row.project_id)).catch((err) =>
      console.error("Airtable Complete update failed (the hourly job retries):", err instanceof Error ? err.message : err),
    ),
  );
  return c.json({ status: "LAUNCHED", approvedAt: at } as ApproveResult);
});

/* ------------------------------ Client status page ------------------------------ */

/**
 * Read-only status for the client's existing private link (the intake link, or the review link
 * once staging is in review): stage, business-day progress and the deadline. Nothing internal.
 */
app.get("/api/status", requireSession, (c) => c.json(statusView(c.env, c.get("session"))));

/* ------------------------------ Re-auth (maintenance) links ------------------------------ */

function maintenanceView(env: Env, m: MaintenanceRow, row: SessionRow): MaintenanceView {
  const live = maintenanceLive(m);
  return {
    projectId: m.project_id,
    clientName: row.client_name,
    agencyName: env.AGENCY_NAME,
    agencyEmail: env.AGENCY_EMAIL,
    requiredIntegrations: parseJson<string[]>(m.required_integrations_json, []),
    note: m.note,
    status: m.status === "OPEN" && !live ? "EXPIRED" : m.status,
    expiresAt: m.token_expires_at,
    submittedAt: m.submitted_at,
  };
}

/**
 * A launched client wants a change, but their keys were wiped 7 days after launch.
 * This makes a private link (/maintenance?token=...) where they re-enter only the keys the change needs.
 * Body: {"requiredIntegrations"?: ["STRIPE_SECRET_KEY"], "note"?: "Add a second booking calendar"}.
 * requiredIntegrations defaults to the keys from the original intake.
 */
app.post("/api/admin/sessions/:projectId/maintenance", requireAdmin, async (c) => {
  const env = c.env;
  const row = await findSessionByProject(env.DB, c.req.param("projectId") ?? "");
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "LAUNCHED") return c.json({ error: "Re-auth links are for launched projects. Before launch, the intake keys are still there." }, 409);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const keys = Array.isArray(b.requiredIntegrations) ? cleanIntegrations(b.requiredIntegrations) : parseJson<string[]>(row.required_integrations_json, []);
  if (keys.length === 0) return c.json({ error: "Name the keys the change needs in requiredIntegrations, e.g. [\"STRIPE_SECRET_KEY\"]." }, 400);
  const note = String(b.note ?? "").trim().slice(0, 500) || null;
  const { id, token, expiresAt } = await createMaintenanceRequest(env.DB, row, {
    requiredIntegrations: keys,
    note,
    ttlDays: numberVar(env.MAINTENANCE_LINK_DAYS, 7),
  });
  const link = `${portalBase(env, c.req.url)}/maintenance?token=${token}`;
  let emailed: string[] = [];
  if (resendConfigured(env)) {
    const mail = maintenanceLinkEmail(env, { clientName: row.spoc_name || row.client_name, projectId: row.project_id, link, expiresAt, note, keys });
    const to = [row.spoc_email, row.client_email].filter((e, i, a): e is string => !!e && a.indexOf(e) === i);
    for (const addr of to) await sendEmail(env, { to: addr, ...mail, idempotencyKey: `maintenance-${id}-${addr}` }, tracked(c, row.project_id));
    emailed = to;
  }
  await audit(env.DB, row, "maintenance.requested", { requestId: id, keys, emailed }); // key names only
  return c.json({ requestId: id, link, expiresAt, emailed, requiredIntegrations: keys }, 201);
});

/** Re-auth requests for one project (never the keys themselves). */
app.get("/api/admin/sessions/:projectId/maintenance", requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, status, required_integrations_json, note, token_expires_at, submitted_at, done_at, secrets_purge_after, secrets_purged_at,
            encrypted_secrets_blob IS NOT NULL AS has_encrypted_secrets, created_at
     FROM maintenance_requests WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(c.req.param("projectId") ?? "")
    .all();
  return c.json({ requests: rows.results ?? [] });
});

/** The change is finished: keys are wiped SECRETS_PURGE_DAYS (7) from now, or sooner if already due. */
app.post("/api/admin/maintenance/:id/done", requireAdmin, async (c) => {
  const env = c.env;
  const m = await env.DB.prepare("SELECT * FROM maintenance_requests WHERE id = ?").bind(c.req.param("id") ?? "").first<MaintenanceRow>();
  if (!m) return c.json({ error: "not found" }, 404);
  const soon = addDaysIso(numberVar(env.SECRETS_PURGE_DAYS, 7));
  const purgeAfter = m.secrets_purge_after && m.secrets_purge_after < soon ? m.secrets_purge_after : soon;
  const at = nowIso();
  await env.DB.prepare(
    "UPDATE maintenance_requests SET status = 'DONE', done_at = COALESCE(done_at, ?), secrets_purge_after = ?, updated_at = ? WHERE id = ?",
  )
    .bind(at, purgeAfter, at, m.id)
    .run();
  await audit(env.DB, { id: m.session_id, project_id: m.project_id }, "maintenance.done", { requestId: m.id, secretsPurgeAfter: purgeAfter });
  return c.json({ status: "DONE", secretsPurgeAfter: purgeAfter });
});

const requireMaintenance = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const bad = () => c.json({ error: "This link isn't valid. Use the link from your email." }, 401);
  if (!TOKEN_RE.test(token)) return bad();
  const m = await findMaintenanceByToken(c.env.DB, token);
  if (!m) return bad();
  const row = await findSessionByProject(c.env.DB, m.project_id);
  if (!row) return bad();
  if (m.status === "EXPIRED" || (m.status === "OPEN" && !maintenanceLive(m))) {
    return c.json({ error: `This link has expired. Email ${c.env.AGENCY_EMAIL} for a fresh one.`, code: "EXPIRED" }, 410);
  }
  c.set("maintenance", m);
  c.set("session", row);
  await next();
};

app.get("/api/maintenance", requireMaintenance, (c) => {
    return c.json(maintenanceView(c.env, c.get("maintenance"), c.get("session")));
});

/** The client re-enters the keys. Encrypted at once (same key and project binding as the intake). */
app.post("/api/maintenance/submit", requireMaintenance, async (c) => {
  const env = c.env;
    const m = c.get("maintenance");
  const row = c.get("session");
  if (m.status !== "OPEN") return c.json({ status: m.status, submittedAt: m.submitted_at });
  if (!env.SECRETS_ENCRYPTION_KEY) {
    await audit(env.DB, row, "submit.blocked", "SECRETS_ENCRYPTION_KEY is not set (maintenance)");
    return c.json({ error: "We can't accept API keys right now. Please email us; nothing was saved." }, 503);
  }
  const b = (await c.req.json().catch(() => null)) as { secrets?: Record<string, unknown> } | null;
  const required = parseJson<string[]>(m.required_integrations_json, []);
  const fields: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const k of required) {
    const v = typeof b?.secrets?.[k] === "string" ? String(b!.secrets![k]).trim() : "";
    if (!v) fields[`secrets.${k}`] = "Paste this key.";
    else if (v.length > 4000 || /\s/.test(v)) fields[`secrets.${k}`] = "This doesn't look like a key (no spaces, up to 4,000 characters).";
    else secrets[k] = v;
  }
  if (Object.keys(fields).length) return c.json({ error: "Some answers need fixing.", fields }, 422);

  const enc = await encryptJson(secrets, env.SECRETS_ENCRYPTION_KEY, row.project_id);
  const at = nowIso();
  const purgeAfter = addDaysIso(numberVar(env.MAINTENANCE_PURGE_DAYS, 14));
  const result = await env.DB.prepare(
    `UPDATE maintenance_requests SET status = 'SUBMITTED', encrypted_secrets_blob = ?, secrets_iv = ?, submitted_at = ?,
       secrets_purge_after = ?, updated_at = ? WHERE id = ? AND status = 'OPEN'`,
  )
    .bind(enc.ciphertext, enc.iv, at, purgeAfter, at, m.id)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return c.json({ status: "SUBMITTED", submittedAt: at });
  await audit(env.DB, row, "maintenance.submitted", { requestId: m.id, keys: Object.keys(secrets), secretsPurgeAfter: purgeAfter });
  waitUntil(
    c,
    sendSlackAlert(
      env,
      {
        channel: "SPRINT_OPS",
        title: `🔑 Keys re-entered for a change: ${row.project_id}`,
        fields: [
          { label: "Client", value: row.client_name },
          { label: "Keys", value: Object.keys(secrets).join(", ") },
          { label: "Wiped", value: formatInZone(purgeAfter, env.BUSINESS_TIMEZONE || DEFAULT_TIMEZONE) },
        ],
        note: m.note ? `Change: ${m.note}` : undefined,
      },
      outbound,
    ),
  );
  return c.json({ status: "SUBMITTED", submittedAt: at, secretsPurgeAfter: purgeAfter });
});

/* ------------------------------ Testimonials ------------------------------ */

const requireTestimonial = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  const token = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const bad = () => c.json({ error: "This link isn't valid. Use the link from your email." }, 401);
  if (!TOKEN_RE.test(token)) return bad();
  const t = await findTestimonialByToken(c.env.DB, token);
  if (!t) return bad();
  const row = await findSessionByProject(c.env.DB, t.project_id);
  if (!row) return bad();
  if (new Date(t.token_expires_at).getTime() <= Date.now() && (t.status === "REQUESTED" || t.status === "PENDING")) {
    return c.json({ error: `This link has expired. Email ${c.env.AGENCY_EMAIL} if you'd still like to share a few words.`, code: "EXPIRED" }, 410);
  }
  c.set("testimonial", t);
  c.set("session", row);
  await next();
};

app.get("/api/testimonial", requireTestimonial, (c) => {
    const t = c.get("testimonial");
  const row = c.get("session");
  const view: TestimonialRequestView = {
    projectId: row.project_id,
    clientName: row.client_name,
    agencyName: c.env.AGENCY_NAME,
    agencyEmail: c.env.AGENCY_EMAIL,
    status: t.status,
    suggestedName: row.spoc_name || row.contact_name || null,
    businessDays: BUSINESS_DAYS_BY_TIER[row.tier],
  };
  return c.json(view);
});

/** The client's two sentences. Saved as PENDING: nothing is public until you approve it. */
app.post("/api/testimonial", requireTestimonial, async (c) => {
  const env = c.env;
    const t = c.get("testimonial");
  const row = c.get("session");
  if (t.status === "APPROVED" || t.status === "REJECTED") return c.json({ status: t.status });
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const quote = String(b.quote ?? "").trim().replace(/\s+/g, " ");
  const authorName = String(b.authorName ?? "").trim();
  const authorRole = String(b.authorRole ?? "").trim().slice(0, 80) || null;
  const company = String(b.company ?? row.client_name).trim().slice(0, 120) || null;
  const linkRaw = String(b.linkUrl ?? "").trim();
  const linkUrl = linkRaw ? httpsOrNull(linkRaw, 500) : null;
  const fields: Record<string, string> = {};
  if (quote.length < TESTIMONIAL_QUOTE_MIN || quote.length > TESTIMONIAL_QUOTE_MAX) {
    fields.quote = `Two short sentences, ${TESTIMONIAL_QUOTE_MIN} to ${TESTIMONIAL_QUOTE_MAX} characters.`;
  }
  if (authorName.length < 2 || authorName.length > 80) fields.authorName = "Type your name as you'd like it shown.";
  if (linkRaw && !linkUrl) fields.linkUrl = "Use a full https:// link, or leave this empty.";
  if (b.consent !== true) fields.consent = "Tick the box so we can show your words.";
  if (Object.keys(fields).length) return c.json({ error: "Some answers need fixing.", fields }, 422);

  const at = nowIso();
  await env.DB.prepare(
    `UPDATE testimonials SET status = 'PENDING', quote = ?, author_name = ?, author_role = ?, company = ?, link_url = ?,
       consent_at = ?, consent_ip = ?, submitted_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(quote, authorName, authorRole, company, linkUrl, at, clientIp(c), at, at, t.id)
    .run();
  await audit(env.DB, row, "testimonial.submitted", { testimonialId: t.id, chars: quote.length });
  waitUntil(
    c,
    sendSlackAlert(
      env,
      {
        channel: "SPRINT_OPS",
        title: `⭐ New testimonial to approve: ${row.project_id}`,
        fields: [
          { label: "Client", value: row.client_name },
          { label: "From", value: `${authorName}${authorRole ? `, ${authorRole}` : ""}` },
          { label: "Quote", value: quote },
        ],
        note: `Approve with POST /api/admin/testimonials/${t.id}/approve (add a "headline" if you like). Nothing shows on the site until then.`,
      },
      outbound,
    ),
  );
  return c.json({ status: "PENDING" });
});

/** Get (or refresh) a project's testimonial link, e.g. to send it yourself while email isn't set up. */
app.post("/api/admin/sessions/:projectId/testimonial-link", requireAdmin, async (c) => {
  const row = await findSessionByProject(c.env.DB, c.req.param("projectId") ?? "");
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "LAUNCHED") return c.json({ error: "Ask for a testimonial after launch." }, 409);
  const link = await testimonialLink(c.env.DB, row, 30);
  await audit(c.env.DB, row, "testimonial.link_issued", { testimonialId: link.id });
  return c.json({ testimonialId: link.id, status: link.status, link: `${portalBase(c.env, c.req.url)}/testimonial?token=${link.token}`, expiresAt: link.expiresAt });
});

app.get("/api/admin/testimonials", requireAdmin, async (c) => {
  const status = String(c.req.query("status") ?? "PENDING").toUpperCase();
  if (!["REQUESTED", "PENDING", "APPROVED", "REJECTED"].includes(status)) return c.json({ error: "status: REQUESTED, PENDING, APPROVED or REJECTED" }, 400);
  const rows = await c.env.DB.prepare(
    `SELECT id, project_id, status, quote, author_name, author_role, company, link_url, headline, consent_at, submitted_at, reviewed_at
     FROM testimonials WHERE status = ? ORDER BY COALESCE(submitted_at, created_at) DESC LIMIT 50`,
  )
    .bind(status)
    .all();
  return c.json({ testimonials: rows.results ?? [] });
});

/**
 * Approve a quote so zp-landing shows it. Optional body: {"headline": "Replaced 6 hours a week of copy-paste",
 * "quote": "<light edit>", "authorName", "authorRole", "company"}. Keep any edit true to what they wrote.
 */
app.post("/api/admin/testimonials/:id/approve", requireAdmin, async (c) => {
  const env = c.env;
  const t = await env.DB.prepare("SELECT * FROM testimonials WHERE id = ?").bind(c.req.param("id") ?? "").first<TestimonialRow>();
  if (!t) return c.json({ error: "not found" }, 404);
  if (t.status !== "PENDING" && t.status !== "APPROVED") return c.json({ error: "The client hasn't sent a quote yet." }, 409);
  if (!t.consent_at) return c.json({ error: "No consent recorded for this quote." }, 409);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const pick = (k: string, cur: string | null, max: number) => (typeof b[k] === "string" ? String(b[k]).trim().slice(0, max) || null : cur);
  const quote = pick("quote", t.quote, TESTIMONIAL_QUOTE_MAX);
  if (!quote || quote.length < TESTIMONIAL_QUOTE_MIN) return c.json({ error: "quote is too short" }, 400);
  const at = nowIso();
  await env.DB.prepare(
    `UPDATE testimonials SET status = 'APPROVED', quote = ?, author_name = ?, author_role = ?, company = ?, headline = ?,
       reviewed_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(quote, pick("authorName", t.author_name, 80), pick("authorRole", t.author_role, 80), pick("company", t.company, 120), pick("headline", t.headline, 140), at, at, t.id)
    .run();
  await audit(env.DB, { id: t.session_id, project_id: t.project_id }, "testimonial.approved", { testimonialId: t.id, edited: typeof b.quote === "string" });
  return c.json({ status: "APPROVED", reviewedAt: at });
});

app.post("/api/admin/testimonials/:id/reject", requireAdmin, async (c) => {
  const env = c.env;
  const t = await env.DB.prepare("SELECT * FROM testimonials WHERE id = ?").bind(c.req.param("id") ?? "").first<TestimonialRow>();
  if (!t) return c.json({ error: "not found" }, 404);
  const at = nowIso();
  await env.DB.prepare("UPDATE testimonials SET status = 'REJECTED', reviewed_at = ?, updated_at = ? WHERE id = ?").bind(at, at, t.id).run();
  await audit(env.DB, { id: t.session_id, project_id: t.project_id }, "testimonial.rejected", { testimonialId: t.id });
  return c.json({ status: "REJECTED" });
});

/** Public: approved quotes only, for zp-landing's "shipped sprints" section. No emails, IPs or project ids. */
app.get("/api/testimonials", async (c) => {
  const list = await approvedTestimonials(c.env.DB);
  return c.json({ testimonials: list });
});

/* ------------------------------ Invoice from a HubSpot scoping deal ------------------------------ */

/** List prices in cents. Tier 3 starts at $10,000, so pass amountCents for anything bigger, or for a deposit. */
const TIER_PRICE_CENTS: Record<Tier, number> = { TIER_1: 150_000, TIER_2: 550_000, TIER_3: 1_000_000 };

/** Next free ZP-<year>-<NNN> id. Skips any id already used by an intake or another deal. */
async function nextProjectId(db: D1Database, year: number): Promise<string> {
  const prefix = `ZP-${year}-`;
  const used = new Set<string>();
  for (const sql of [
    "SELECT project_id FROM deal_projects WHERE project_id LIKE ?",
    "SELECT project_id FROM onboarding_sessions WHERE project_id LIKE ?",
  ]) {
    for (const r of (await db.prepare(sql).bind(`${prefix}%`).all<{ project_id: string }>()).results ?? []) used.add(r.project_id);
  }
  let n = 1;
  for (const id of used) {
    const m = /^ZP-\d{4}-(\d{1,6})$/.exec(id);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return `${prefix}${String(n).padStart(3, "0")}`;
}

/**
 * The lead said yes on the scoping call: make the Stripe invoice from their HubSpot deal, with project_id,
 * tier, company and contact filled in, then move the deal to HUBSPOT_INVOICE_STAGE.
 * Body: {"dealId":"123","tier":"TIER_2","amountCents"?:550000,"milestone"?:"deposit","integrations"?:[],
 *        "projectId"?:"ZP-2026-015","daysUntilDue"?:7,"send"?:false}
 * Same deal again = same project id. send defaults to false here: you get a finalized invoice and its
 * hosted link to check, then call again with "send": true to email it.
 */
app.post("/api/admin/invoices/from-deal", requireAdmin, async (c) => {
  const env = c.env;
  if (!env.HUBSPOT_ACCESS_TOKEN) return c.json({ error: "Add the HUBSPOT_ACCESS_TOKEN secret first (same token as zp-landing)." }, 503);
  if (!env.STRIPE_SECRET_KEY) return c.json({ error: "Add the STRIPE_SECRET_KEY secret first." }, 503);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const dealId = String(b.dealId ?? b.deal_id ?? "").trim();
  if (!/^\d{1,20}$/.test(dealId)) return c.json({ error: "dealId: the HubSpot deal's number (Record ID)" }, 400);

  const f = tracked(c, null);
  const deal = await readDealForInvoice(env, dealId, f).catch((err) => err as Error);
  if (deal instanceof Error) return c.json({ error: deal.message }, 502);

  const tier = String(b.tier ?? deal.tierInterest ?? "").trim().toUpperCase() as Tier;
  if (!TIERS.includes(tier)) return c.json({ error: "tier must be TIER_1, TIER_2 or TIER_3 (the deal doesn't say)" }, 400);

  const known = await env.DB.prepare("SELECT project_id, tier FROM deal_projects WHERE deal_id = ?").bind(dealId).first<{ project_id: string; tier: string }>();
  let projectId = known?.project_id ?? String(b.projectId ?? "").trim();
  if (!known) {
    if (projectId && !PROJECT_ID_RE.test(projectId)) return c.json({ error: "projectId: letters, numbers, dot, dash, underscore" }, 400);
    if (projectId && (await findSessionByProject(env.DB, projectId))) return c.json({ error: "That projectId is already used by an intake." }, 409);
    if (!projectId) projectId = await nextProjectId(env.DB, new Date().getUTCFullYear());
    await env.DB.prepare("INSERT INTO deal_projects (deal_id, project_id, tier) VALUES (?, ?, ?)").bind(dealId, projectId, tier).run();
  }

  const res = await issueInvoice(
    c,
    {
      projectId,
      tier,
      companyName: deal.companyName,
      contactName: deal.contactName,
      contactEmail: deal.contactEmail,
      integrations: b.integrations,
      amountCents: b.amountCents ?? TIER_PRICE_CENTS[tier],
      milestone: b.milestone ?? "deposit",
      daysUntilDue: b.daysUntilDue ?? 7,
      description: b.description,
      send: b.send === true,
    },
    dealId,
  );
  if (res.status !== 201) return res;
  const out = (await res.clone().json()) as { hostedInvoiceUrl: string | null; amountCents: number };
  await markDealInvoiced(env, { dealId, projectId, amountCents: out.amountCents, invoiceUrl: out.hostedInvoiceUrl }, f).catch((err) =>
    console.error("HubSpot deal stage update failed:", err instanceof Error ? err.message : err),
  );
  return c.json({ ...(await res.json()), dealId, contactEmail: deal.contactEmail, companyName: deal.companyName }, 201);
});

/** Run the housekeeping job now instead of waiting for the cron. */
app.post("/api/admin/run-cron", requireAdmin, async (c) => c.json(await runScheduled(c.env, outbound)));

app.notFound((c) => c.json({ error: "not found" }, 404));

export { app };

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runScheduled(env, outbound).catch((err) =>
        reportWorkerError(
          env,
          { service: "zp-intake-portal", step: "hourly cron", status: "exception", detail: err instanceof Error ? err.stack ?? err.message : String(err) },
          outbound,
        ),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
