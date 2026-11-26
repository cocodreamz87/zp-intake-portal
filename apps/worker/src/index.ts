import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  buildIntakeSchema,
  flattenIssues,
  SECRET_KEY_RE,
  TIERS,
  type IntakePayload,
  type SessionView,
  type SubmitResult,
  type Tier,
} from "@zinkpress/shared";
import { encryptJson, timingSafeEqual, TOKEN_RE } from "./crypto";
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
import { formatInZone, intakeLinkEmail, sendEmail } from "./email";
import { numberVar, resendConfigured, type Env } from "./env";
import { checkUpload, type UploadKind } from "./files";
import { runPostSubmit, runScheduled } from "./followups";
import { checkGithubAccount } from "./github";
import { calculateSprintSchedule, DEFAULT_TIMEZONE, parseHolidays } from "./schedule";
import { formatMoney, sendSlackAlert, tierLabel } from "./services/slack";
import { readPaidInvoice, verifyStripeSignature } from "./stripe";

/** Outbound fetch. Tests swap this for a fake so nothing real is ever called. */
let outbound: typeof fetch = (...args) => fetch(...args);
export function setOutboundFetch(f: typeof fetch) {
  outbound = f;
}

type AppEnv = { Bindings: Env; Variables: { session: SessionRow } };
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
  c.header("Cache-Control", "no-store");
});

app.onError((err, c) => {
  console.error(err);
  // Tell #worker-errors. Runs in the background and can't throw, so the
  // caller (Stripe, the wizard) still gets its normal 500 answer.
  const stack = err instanceof Error && err.stack ? err.stack.split("\n").slice(0, 6).join("\n") : String(err);
  waitUntil(
    c,
    sendSlackAlert(
      c.env,
      {
        channel: "ERRORS",
        title: `🔴 Worker error: ${c.req.method} ${c.req.path}`,
        fields: [
          { label: "Route", value: `${c.req.method} ${c.req.path}` },
          { label: "Status", value: "500" },
          { label: "Time", value: new Date().toISOString() },
        ],
        note: stack,
      },
      outbound,
    ),
  );
  return c.json({ error: "Something went wrong on our side. Please try again in a minute." }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true }));

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
  };
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
  const result = await checkGithubAccount(c.req.query("name") ?? "", c.env.GITHUB_TOKEN, outbound);
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

  if (row.status === "CLOCK_RUNNING" || row.status === "LAUNCHED") {
    // Double-click or a retry after a dropped connection: same answer, no second clock.
    return c.json({ clockStartedAt: row.clock_started_at, guaranteedDeadline: row.guaranteed_deadline } as SubmitResult);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Send the form as JSON." }, 400);

  const required = parseJson<string[]>(row.required_integrations_json, []);
  const parsed = buildIntakeSchema({ tier: row.tier, requiredIntegrations: required }).safeParse(body);
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
  const gh = await checkGithubAccount(data.githubTarget, env.GITHUB_TOKEN, outbound);
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
       spoc_name = ?, spoc_email = ?,
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
  s: { projectId: string; clientName: string; clientEmail: string; tier: Tier; requiredIntegrations: string[]; invoiceId?: string | null },
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
    });
    ({ token, expiresAt } = created);
    row = { id: created.id, project_id: s.projectId };
    await audit(env.DB, row, "session.created", { tier: s.tier, invoiceId: s.invoiceId ?? null });
  }

  const link = `${baseUrl}/?token=${token}`;
  let emailed = false;
  if (resendConfigured(env)) {
    const mail = intakeLinkEmail(env, { clientName: s.clientName, projectId: s.projectId, link, expiresAt });
    await sendEmail(env, { to: s.clientEmail, ...mail, idempotencyKey: `intake-${row.id}-${expiresAt}` }, outbound);
    await env.DB.prepare("UPDATE onboarding_sessions SET intake_email_sent_at = ?, updated_at = ? WHERE id = ?")
      .bind(nowIso(), nowIso(), row.id)
      .run();
    emailed = true;
    await audit(env.DB, row, "intake.emailed", { to: s.clientEmail });
  }
  return { status: "created" as const, link, emailed, expiresAt };
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

  // If this throws (for example the email fails), we answer 500 and Stripe retries later.
  const result = await startIntake(env, portalBase(env, c.req.url), {
    projectId: info.projectId,
    clientName: info.clientName,
    clientEmail: info.clientEmail,
    tier: info.tier as Tier,
    requiredIntegrations: cleanIntegrations(info.requiredIntegrations),
    invoiceId: info.invoiceId,
  });
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
  const { token_hash, encrypted_secrets_blob, secrets_iv, ...safe } = row;
  const log = await c.env.DB.prepare(
    "SELECT event, detail, created_at FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT 50",
  )
    .bind(row.project_id)
    .all();
  return c.json({ ...safe, has_encrypted_secrets: Boolean(encrypted_secrets_blob), audit: log.results });
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
  if (row.status !== "CLOCK_RUNNING" && row.status !== "LAUNCHED") return c.json({ error: "Not started yet." }, 409);
  const purgeAfter = addDaysIso(numberVar(c.env.SECRETS_PURGE_DAYS, 7));
  await c.env.DB.prepare(
    "UPDATE onboarding_sessions SET status = 'LAUNCHED', launched_at = COALESCE(launched_at, ?), secrets_purge_after = COALESCE(secrets_purge_after, ?), updated_at = ? WHERE id = ?",
  )
    .bind(nowIso(), purgeAfter, nowIso(), row.id)
    .run();
  await audit(c.env.DB, row, "launched", { secretsPurgeAfter: purgeAfter });
  return c.json({ status: "LAUNCHED", secretsPurgeAfter: row.secrets_purge_after ?? purgeAfter });
});

/** Run the housekeeping job now instead of waiting for the cron. */
app.post("/api/admin/run-cron", requireAdmin, async (c) => c.json(await runScheduled(c.env, outbound)));

app.notFound((c) => c.json({ error: "not found" }, 404));

export { app };

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, outbound));
  },
} satisfies ExportedHandler<Env>;
