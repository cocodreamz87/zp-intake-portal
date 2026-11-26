# zp-intake-portal: integrations and APIs

Internal reference for every API this Worker serves and every service it calls.
No secret values appear here; secrets live only in Cloudflare (Settings → Variables and Secrets).

Sister doc: [zp-landing integrations](https://github.com/cocodreamz87/zp-landing/blob/main/docs/INTEGRATIONS.md).

## The pipeline, end to end

```
Stripe invoice.paid ──► zp-intake-portal  POST /api/stripe/webhook
                          └─ D1 session + private intake link (emailed by Resend, or reissued by admin)
Client ──► intake form ──► POST /api/onboarding/submit ──► delivery clock starts
                          ├─ Jira epic + tasks                   (optional)
                          ├─ Resend kickoff receipt              (optional)
                          └─ zp-landing POST /api/onboard        (optional)
                               └─ Drive folder (shared with client), Airtable Clients row,
                                  HubSpot contact/company/deal, Resend welcome email, Slack
```

Only this Worker listens to Stripe. zp-landing's own Stripe route no longer onboards anyone.
Every "after submit" step records its own done-column in D1, so the hourly cron retries only what failed.

## Internal API (served by this Worker)

Base URL: `https://zp-intake-portal.peaceiam4now.workers.dev` (or `PORTAL_URL` once a custom domain is set).
Every `/api/*` response sends `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
CORS: only origins listed in `ALLOWED_ORIGIN` (comma list); same-site calls need none. Errors are JSON `{"error": "..."}`.

### Auth types

| Auth | How | Used by |
|---|---|---|
| Client link token | `Authorization: Bearer <43-char token>`. Only its SHA-256 is stored. Expires after `TOKEN_TTL_DAYS` (14). | client routes |
| Admin token | `Authorization: Bearer <ADMIN_API_TOKEN>` (secret, 24+ chars), constant-time compare | admin routes |
| Stripe signature | `Stripe-Signature: t=…,v1=…`, HMAC-SHA256 of `t.rawBody` with `STRIPE_WEBHOOK_SECRET`, 5-minute window, constant-time compare | Stripe webhook |

### Public

| Method & path | Auth | Request | Response |
|---|---|---|---|
| `GET /api/health` | none | none | `200 {"ok":true}` |

### Client routes (the intake form)

| Method & path | Request | Responses |
|---|---|---|
| `GET /api/session` | none | `200` session view: `projectId, clientName, tier, status, requiredIntegrations[], agencyName, agencyEmail, cloudflareHelpUrl, timeZone, tokenExpiresAt, clockStartedAt, guaranteedDeadline`. `401` bad token, `410 {"code":"EXPIRED"}` expired link. |
| `GET /api/github/check?name=<login>` | query `name` | `200 {"status":"exists","type":"User"/"Organization","login"}` or `{"status":"not_found"}`, `{"status":"invalid"}`, `{"status":"unverified","reason"}` (GitHub down or rate limited). |
| `POST /api/assets/upload` | `multipart/form-data`: `file`, `kind` = `logo` or `asset` | `200 {"key":"<project_id>/assets/logo-<uuid>.<ext>", …}`. File bytes are checked (logo: SVG, EPS, or transparent PNG at least 1,000 px wide, 10 MB max; other brand files 25 MB max). `400` no file, `409` already submitted, `422` file rejected. |
| `POST /api/onboarding/submit` | JSON intake: `registrarProvider, registrarDelegatedConfirmed, cloudflareAdminConfirmed, githubTarget, logoKey, assetKeys[], primaryHex, secondaryHex, font, copy{mode:"link",url}/{mode:"typed",…}, copyFinalizedConfirmed, secrets{KEY:value}, adminEmails[], spocName, spocEmail` (schema in `packages/shared/src/intake.ts`) | `200 {"clockStartedAt","guaranteedDeadline"}`. `422 {"error","fields":{…}}` with per-field messages. Idempotent: a repeat submit returns the same clock and starts nothing new. |

On a successful submit: API keys are encrypted (AES-256-GCM, key from `SECRETS_ENCRYPTION_KEY`, bound to the project id), the clock starts at the next 9:00 AM business morning in `BUSINESS_TIMEZONE`, and the deadline is 5 / 10 / 20 business days later for Tier 1 / 2 / 3 (weekends and `HOLIDAYS` skipped). Then the post-submit job runs in the background.

### Stripe webhook

`POST /api/stripe/webhook`, Stripe signature auth.

- Acts only on `invoice.paid`. Reads invoice metadata: `project_id` (required), `tier` = `TIER_1`/`TIER_2`/`TIER_3` (required), `client_name` (optional, falls back to `customer_name`), `integrations` (optional comma list of key names). Needs `customer_email` on the invoice.
- `200 {"received":true,"session":"created"|"exists"}`, `200 {"received":true,"duplicate":true}` for a repeat event id (table `stripe_events`), `200 {"received":true,"ignored":"<reason>"}` for other types or missing metadata (logged as `stripe.ignored`), `400 {"error":"bad signature"}`, `500` if the intake email fails (Stripe retries).

### Admin routes

| Method & path | Request | Response |
|---|---|---|
| `POST /api/admin/sessions` | `{"projectId","tier","clientEmail","clientName"?,"requiredIntegrations"?[]}` | `201 {"status":"created","link","emailed","expiresAt"}`, `400` bad field, `409` exists. Starts an intake without Stripe. |
| `GET /api/admin/sessions/:projectId` | none | Session row (no token hash, no ciphertext) plus `has_encrypted_secrets` and the last 50 audit events. `404`. |
| `POST /api/admin/sessions/:projectId/reissue` | none | `200 {"link","expiresAt","emailed"}`. The old link stops working. `409` if already submitted. |
| `POST /api/admin/sessions/:projectId/launched` | none | `200 {"status":"LAUNCHED","secretsPurgeAfter"}`. Keys are wiped `SECRETS_PURGE_DAYS` (7) later. |
| `POST /api/admin/run-cron` | none | Runs housekeeping now; returns `{"secretsPurged","linksExpired","followupsRetried"}`. |

### Cron (hourly, `17 * * * *`)

1. Wipes client API keys past their purge date.
2. Marks unfinished links past expiry as `EXPIRED`.
3. Retries Jira, the kickoff receipt and the zp-landing hand-off for up to 10 `CLOCK_RUNNING` sessions where any of `jira_synced_at`, `receipt_sent_at`, `landing_synced_at` is empty.

## Outgoing calls (this Worker calls them)

### zp-landing `/api/onboard` (internal)

- **Enabled by:** secrets `ZP_LANDING_ONBOARD_URL` (`https://zp-landing.peaceiam4now.workers.dev/api/onboard`) and `ZP_LANDING_WEBHOOK_SECRET` (same value as `WEBHOOK_SECRET` on zp-landing). Either empty = skipped, logged `landing.skipped`.
- **When:** right after submit, then hourly until done.
- **Request:** `POST`, headers `Content-Type: application/json`, `X-Webhook-Secret: <ZP_LANDING_WEBHOOK_SECRET>`. Body:
  ```json
  {
    "event_id": "<project_id>",
    "company_name": "<client_name || spoc_name || client_email>",
    "contact_name": "<spoc_name || client_name>",
    "contact_email": "<spoc_email || client_email>",
    "scope_tier": "TIER_1 | TIER_2 | TIER_3"
  }
  ```
- **Idempotency:** `event_id` is the project id, so zp-landing dedupes and resumes the same run (KV key `evt:<project_id>`).
- **Result handling:** any 2xx (including `"status":"partial"` and `"already_processed"`) sets `landing_synced_at` and logs `landing.synced` with zp-landing's answer. Anything else (401, 409, 500, network error) goes into `last_error`, logs `followup.failed`, and the cron retries.

### Stripe (inbound only)

The Worker never calls Stripe's API and needs no Stripe API key. Stripe → Developers → Webhooks: one endpoint, `<portal>/api/stripe/webhook`, event `invoice.paid` only; its signing secret is `STRIPE_WEBHOOK_SECRET`.

### Resend (email)

- **Enabled by:** secret `RESEND_API_KEY` **and** var `RECEIPT_FROM_EMAIL` (a sender on a Resend-verified domain). If either is empty nothing is emailed; `AGENCY_EMAIL` (Proton) is never used as the sender because Resend rejects it. `AGENCY_EMAIL` is the `reply_to`.
- **Endpoint:** `POST https://api.resend.com/emails`, `Authorization: Bearer <RESEND_API_KEY>`, body `{from, to:[…], reply_to, subject, html, text}`.
- **Emails and idempotency keys:**
  - Intake link (invoice paid, admin create, reissue): `intake-<sessionId>-<expiresAt>`.
  - Kickoff receipt (after submit, to client and approver): `receipt-<sessionId>-<address>`; tracked by `receipt_sent_at`, retried by cron.
- **Failures:** non-2xx throws with status and first 300 chars of the body. An intake-link failure on the Stripe webhook returns 500 so Stripe retries.

### Jira Cloud (optional)

- **Enabled by:** vars `JIRA_DOMAIN`, `JIRA_PROJECT_KEY` (`JIRA_EPIC_TYPE`, `JIRA_TASK_TYPE` default Epic/Task) and secrets `JIRA_EMAIL`, `JIRA_API_TOKEN`. Any missing = skipped (`jira.skipped`).
- **Endpoints:** `POST https://<JIRA_DOMAIN>/rest/api/3/search/jql` (find existing epic/tasks by label), `POST /rest/api/3/issue` (epic), `POST /rest/api/3/issue/bulk` (missing tasks). Basic auth `JIRA_EMAIL:JIRA_API_TOKEN`.
- **Payload:** epic `[<project_id>] <client> · TIER n Sprint`, due on the deadline's Eastern date, labels `tier-n`, `automated-intake`, `zp-<project_id>`; Tier 1/2/3 get 5/7/9 tasks. Secrets never go into Jira.
- **Idempotency:** the project label lets a retry find the epic and create only missing tasks; `jira_epic_key` and `jira_synced_at` in D1.

### GitHub (account check)

- `GET https://api.github.com/users/<login>` with `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: zp-intake-portal`, and `Authorization: Bearer <GITHUB_TOKEN>` if set.
- **Optional secret** `GITHUB_TOKEN` (fine-grained, no permissions) raises the limit from about 60 to 5,000 lookups an hour.
- 404 blocks the submit with a field error; any other failure lets the client through as `unverified`.

## Cloudflare bindings

| Binding | Resource | What's in it |
|---|---|---|
| `DB` | D1 `zp-intake` (`dbe569b8-56f6-48db-9e8b-c0e50551e4c3`) | `onboarding_sessions` (one row per project, incl. `jira_synced_at`, `receipt_sent_at`, `landing_synced_at`), `audit_log` (key names only, never values), `stripe_events`. Migrations in `apps/worker/migrations`; apply with `npm run db:migrate:remote`. |
| `ASSETS_BUCKET` | R2 `zp-intake-assets` (private) | `<project_id>/assets/logo-<uuid>.<ext>` and `asset-<uuid>.<ext>`, custom metadata `originalName`, `sessionId`. |
| `[assets]` | `apps/web/dist` | The intake form (SPA); `/api/*` runs the Worker first. |
| cron | `17 * * * *` | Housekeeping above. |

## Audit log events

`session.created`, `intake.emailed`, `asset.uploaded`, `clock.started`, `submit.blocked`, `jira.synced`, `jira.skipped`, `receipt.sent`, `receipt.skipped`, `landing.synced`, `landing.skipped`, `followup.failed`, `link.reissued`, `launched`, `stripe.ignored`, `cron`.

## Settings matrix

| Name | Kind | Needed for | Empty means |
|---|---|---|---|
| `SECRETS_ENCRYPTION_KEY` | secret | encrypting client API keys | submits with keys are blocked |
| `ADMIN_API_TOKEN` | secret | admin routes | admin routes return 401 |
| `STRIPE_WEBHOOK_SECRET` | secret | Stripe webhook | every webhook call is rejected |
| `RESEND_API_KEY` | secret | email | no email |
| `RECEIPT_FROM_EMAIL` | var | email sender | no email |
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | secrets | Jira | Jira skipped |
| `JIRA_DOMAIN`, `JIRA_PROJECT_KEY`, `JIRA_EPIC_TYPE`, `JIRA_TASK_TYPE` | vars | Jira | Jira skipped |
| `GITHUB_TOKEN` | secret | GitHub rate limit | about 60 lookups an hour |
| `ZP_LANDING_ONBOARD_URL`, `ZP_LANDING_WEBHOOK_SECRET` | secrets | hand-off to zp-landing | hand-off skipped |
| `AGENCY_NAME`, `AGENCY_EMAIL` | vars | email copy, reply-to, form | |
| `PORTAL_URL`, `ALLOWED_ORIGIN` | vars | link base, CORS | Worker's own address, same site only |
| `BUSINESS_TIMEZONE`, `HOLIDAYS` | vars | clock | America/New_York, no holidays |
| `TOKEN_TTL_DAYS`, `SECRETS_PURGE_DAYS` | vars | link life, key wipe | 14, 7 |
| `STAGING_URL_TEMPLATE`, `CLOUDFLARE_HELP_URL` | vars | receipt and form copy | |

Change vars in `wrangler.toml` (a deploy overwrites dashboard vars); add secrets in the dashboard.
