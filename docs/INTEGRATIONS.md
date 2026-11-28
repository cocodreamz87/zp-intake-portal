# zp-intake-portal: integrations and APIs

Internal reference for every API this Worker serves and every service it calls.
No secret values appear here; secrets live only in Cloudflare (Settings → Variables and Secrets).

Sister doc: [zp-landing integrations](https://github.com/cocodreamz87/zp-landing/blob/main/docs/INTEGRATIONS.md).

## The pipeline, end to end

```
POST /api/admin/invoices ──► Stripe invoice (bank transfer only at $500+), sent to the client
Stripe invoice.paid ──► zp-intake-portal  POST /api/stripe/webhook
                          ├─ $500+ paid by card (or anything but a bank rail) ──► blocked, #worker-errors
                          ├─ D1 session + private intake link (emailed by Resend, or reissued by admin)
                          └─ PandaDoc MSA/SOW draft ──► #contract-approvals "Approve & Send Contract"
                               └─ POST /api/slack/interactions ──► PandaDoc sends it to the client
PandaDoc document.completed ──► POST /api/pandadoc/webhook ──► SIGNED
                          ├─ signed PDF ──► R2 <project_id>/contracts/<project_id>-MSA-SOW-SIGNED.pdf
                          └─ zp-landing POST /api/contracts/upload ──► client's Drive 01_Contracts_and_Scope
Client ──► intake form ──► POST /api/onboarding/submit ──► delivery clock starts
                          ├─ Jira epic + tasks                   (optional)
                          ├─ Resend kickoff receipt              (optional)
                          └─ zp-landing POST /api/onboard        (optional)
                               └─ Drive folder (shared with client), Airtable Clients row,
                                  HubSpot contact/company/deal, Resend welcome email, Slack
Staging ready ──► POST /api/admin/sessions/:id/ready-for-review ──► IN_REVIEW, /review?token=… emailed + #staging-approvals
Client ──► /review ──► POST /api/review/approve ──► LAUNCHED, keys wiped 7 days later,
                          #staging-approvals, zp-landing POST /api/clients/status ──► Airtable "Complete"
Every outside call that fails, and every 500 ──► #worker-errors (both Workers, 6-hour de-dupe)
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
| Slack signature | `X-Slack-Signature: v0=…` = HMAC-SHA256 of `v0:<X-Slack-Request-Timestamp>:<raw body>` with `SLACK_SIGNING_SECRET`, 5-minute window | Slack button clicks |
| PandaDoc signature | `?signature=<hex>` = HMAC-SHA256 of the raw body with `PANDADOC_WEBHOOK_KEY` | PandaDoc webhook |

### Public

| Method & path | Auth | Request | Response |
|---|---|---|---|
| `GET /api/health` | none | none | `200 {"ok":true}` |

### Client routes (the intake form)

| Method & path | Request | Responses |
|---|---|---|
| `GET /api/session` | none | `200` session view: `projectId, clientName, tier, status, requiredIntegrations[], agencyName, agencyEmail, cloudflareHelpUrl, timeZone, tokenExpiresAt, clockStartedAt, guaranteedDeadline, businessCheckRequired, companyEmailRequired`. `401` bad token, `410 {"code":"EXPIRED"}` expired link. |
| `GET /api/github/check?name=<login>` | query `name` | `200 {"status":"exists","type":"User"/"Organization","login"}` or `{"status":"not_found"}`, `{"status":"invalid"}`, `{"status":"unverified","reason"}` (GitHub down or rate limited). |
| `POST /api/assets/upload` | `multipart/form-data`: `file`, `kind` = `logo` or `asset` | `200 {"key":"<project_id>/assets/logo-<uuid>.<ext>", …}`. File bytes are checked (logo: SVG, EPS, or transparent PNG at least 1,000 px wide, 10 MB max; other brand files 25 MB max). `400` no file, `409` already submitted, `422` file rejected. |
| `GET /api/review` | none | `200` review view: `projectId, clientName, tier, status, agencyName, agencyEmail, stagingUrl, loomUrl, loomEmbedUrl, releaseNotes, reviewRequestedAt, approvedAt, approvedBy`. `409` nothing to review yet, `410` review link expired. |
| `POST /api/review/approve` | `{"confirmed":true,"signerName":"<full name>"}` | `200 {"status":"LAUNCHED","approvedAt"}` (repeat clicks return the same). `422 {"fields":{"confirmed"/"signerName"}}`, `409` not in review. Sets `launched_at`, `secrets_purge_after = now + SECRETS_PURGE_DAYS` (7), `client_approved_at`, `client_approval_ip` (`CF-Connecting-IP`), `client_approval_name`; audit `review.approved` holds name, IP, time, user agent and the exact sign-off sentence. Then #staging-approvals and the Airtable "Complete" update. |
| `POST /api/onboarding/submit` | JSON intake: `registrarProvider, registrarDelegatedConfirmed, cloudflareAdminConfirmed, githubTarget, legalBusinessName, einOrRegistration, logoKey, assetKeys[], primaryHex, secondaryHex, font, copy{mode:"link",url}/{mode:"typed",…}, copyFinalizedConfirmed, secrets{KEY:value}, adminEmails[], spocName, spocEmail` (schema in `packages/shared/src/intake.ts`) | `200 {"clockStartedAt","guaranteedDeadline"}`. `422 {"error","fields":{…}}` with per-field messages. Idempotent: a repeat submit returns the same clock and starts nothing new. |

**Business check (KYB):** on Tier 2/3, or any invoice of $2,500 or more, Step 1 requires `legalBusinessName` and `einOrRegistration` (EIN like `12-3456789` or a state registration number), and the approver email (`spocEmail`) can't be a free mailbox (`gmail.com`, `yahoo.com`, `hotmail.com`, `outlook.com`, `icloud.com`, plus `googlemail.com`, `ymail.com`, `live.com`, `msn.com`, `me.com`, `mac.com`, `aol.com`, `protonmail.com`, `proton.me`, `gmx.com`, `mail.com`). `POST /api/admin/sessions/:id/kyb-override` lifts the email rule for one project. A Tier 2/3 invoice paid from a free mailbox is logged `kyb.webmail_flagged`. The EIN is stored in D1 only: never in Slack, PandaDoc, email or the audit log, and the admin view shows its last 4 characters.

On a successful submit: API keys are encrypted (AES-256-GCM, key from `SECRETS_ENCRYPTION_KEY`, bound to the project id), the clock starts at the next 9:00 AM business morning in `BUSINESS_TIMEZONE`, and the deadline is 5 / 10 / 20 business days later for Tier 1 / 2 / 3 (weekends and `HOLIDAYS` skipped). Then the post-submit job runs in the background.

### Client status, re-auth and testimonial pages

| Method & path | Auth | Request | Response |
|---|---|---|---|
| `GET /api/status` | client link token (the intake link, or the review link once in review) | none | `200` `projectId, clientName, tier, status, stage` (`INTAKE_COMPLETE` before the 9:00 AM kickoff, `BUILDING`, `STAGING_REVIEW`, `LAUNCHED`), `timeZone, clockStartedAt, guaranteedDeadline, businessDaysTotal, businessDaysElapsed, businessDaysLeft, percent, reviewRequestedAt, launchedAt`. A day counts once its 9:00 AM boundary passes. No keys, contract, KYB or approver details. The form shows this page on the same link after submit, with a live countdown. |
| `GET /api/maintenance` | re-auth link token (`/maintenance?token=…`) | none | `200 {projectId, clientName, requiredIntegrations[], note, status, expiresAt, submittedAt}`. `401` bad link, `410` expired or replaced. |
| `POST /api/maintenance/submit` | re-auth link token | `{"secrets":{"KEY":"value"}}` (only the listed keys are kept) | `200 {"status":"SUBMITTED","submittedAt","secretsPurgeAfter"}`; repeat = same answer, nothing overwritten. `422 {"fields":{"secrets.KEY"}}`, `503` without `SECRETS_ENCRYPTION_KEY`. Encrypted like the intake (AES-256-GCM, bound to the project id). Read locally with `node scripts/reveal-secrets.mjs <project> --maintenance`. |
| `GET /api/testimonial` | testimonial link token (`/testimonial?token=…`) | none | `200 {projectId, clientName, status, suggestedName, businessDays, …}`. |
| `POST /api/testimonial` | testimonial link token | `{"quote","authorName","authorRole"?,"company"?,"linkUrl"?,"consent":true}` | `200 {"status":"PENDING"}`; quote 20 to 400 characters; consent required and saved with time and IP. Posts "⭐ New testimonial to approve" to #sprint-ops. |
| `GET /api/testimonials` | none (public) | none | `200 {"testimonials":[{id, quote, authorName, authorRole, company, headline, tier, businessDays, linkUrl, approvedAt}]}`, approved and consented only, `Cache-Control: public, max-age=300`. zp-landing reads it. |

### Stripe webhook

`POST /api/stripe/webhook`, Stripe signature auth.

- Acts only on `invoice.paid`. Reads invoice metadata: `project_id` (required), `tier` = `TIER_1`/`TIER_2`/`TIER_3` (required), `company_name` or `client_name` (optional, falls back to `customer_name`), `contact_name` (the signer), `contact_email` (fallback for `customer_email`), `integrations` (optional comma list of key names). Stores `amount_paid`, `currency` and the payment rail.
- **$500+ is bank transfer only.** When `amount_paid >= 50000`, it works out how the invoice was paid: from the event if Stripe expanded the charge, else `GET /v1/invoice_payments?invoice=<id>` → `GET /v1/payment_intents/<pi>?expand[]=latest_charge` (older API versions: `GET /v1/invoices/<id>` → charge). Accepted: `us_bank_account`, `customer_balance` (bank transfer / wire into the Stripe cash balance), `ach_credit_transfer`, `ach_debit`, `wire`, and `paid_out_of_band` (you marked it paid by hand). Anything else (card, Link, wallets) does **not** start the intake: `200 {"received":true,"blocked":"stripe.blocked_card_over_500"}` (or `stripe.blocked_rail_over_500`), audit entry, the event is marked done, and #worker-errors gets a "refund and re-issue for ACH or wire" alert. If the rail can't be checked (no `STRIPE_SECRET_KEY`, or Stripe errors) it answers `503 {"held":"payment_rail_unverified"}` so Stripe retries the same event later, and alerts.
- New sessions with PandaDoc configured get their contract drafted right after (see Contracts).
- `200 {"received":true,"session":"created"|"exists"}`, `200 {"received":true,"duplicate":true}` for a repeat event id (table `stripe_events`), `200 {"received":true,"ignored":"<reason>"}` for other types or missing metadata (logged as `stripe.ignored`), `400 {"error":"bad signature"}`, `500` if the intake email fails (Stripe retries).

### Admin routes

| Method & path | Request | Response |
|---|---|---|
| `POST /api/admin/sessions` | `{"projectId","tier","clientEmail","clientName"?,"requiredIntegrations"?[]}` | `201 {"status":"created","link","emailed","expiresAt"}`, `400` bad field, `409` exists. Starts an intake without Stripe. |
| `GET /api/admin/sessions/:projectId` | none | Session row (no token hash, no ciphertext) plus `has_encrypted_secrets` and the last 50 audit events. `404`. |
| `POST /api/admin/sessions/:projectId/reissue` | none | `200 {"link","expiresAt","emailed"}`. The old link stops working. `409` if already submitted. |
| `POST /api/admin/sessions/:projectId/launched` | none | `200 {"status":"LAUNCHED","secretsPurgeAfter"}`. Keys are wiped `SECRETS_PURGE_DAYS` (7) later. Manual launch without client sign-off. |
| `POST /api/admin/invoices` | `{"projectId","tier","companyName","contactName","contactEmail","integrations"?[],"amountCents","currency"?:"usd","milestone"?:"deposit","daysUntilDue"?:7,"description"?,"send"?:true}` | `201 {"invoiceId","customerId","status","hostedInvoiceUrl","sent","bankOnly"}`. Reuses the Stripe customer with that email. At $500+ sets `payment_settings.payment_method_types = ["us_bank_account","customer_balance"]` (US bank transfer); under $500 your Stripe defaults apply. Metadata: `project_id, tier, company_name, client_name, contact_name, contact_email, integrations, milestone`. Idempotency keys `zp-<project>-<milestone>-<amount>-…`. `503` without `STRIPE_SECRET_KEY`. |
| `POST /api/admin/sessions/:projectId/kyb-override` | `{"allowWebmail":true,"reason":"…"}` (`false` to undo) | `200`. Lets the approver use a free mailbox on this project. |
| `POST /api/contracts/draft` | `{"projectId"}` | `201 {"status":"drafted","documentId"}` or `200 {"status":"exists"}`. Makes the PandaDoc draft now and posts it to #contract-approvals. `503` without PandaDoc settings. |
| `POST /api/admin/sessions/:projectId/send-contract` | none | Fallback for the Slack button. `200 {"status":"sent"}`, `409 {"status":"already"}`, `425 {"status":"not_ready","reason"}` (no draft yet, or PandaDoc still preparing it). |
| `POST /api/admin/sessions/:projectId/ready-for-review` | `{"stagingUrl":"https://…","loomUrl":"https://www.loom.com/share/<id>","releaseNotes":"…"}` | `200 {"status":"IN_REVIEW","link","expiresAt","emailed"[]}`. Issues a new link token (the old intake link stops working), emails `/review?token=…` to the approver and client (when Resend is set up), and posts it to #staging-approvals. `400` bad links, `409` not submitted yet or already launched. |
| `POST /api/admin/invoices/from-deal` | `{"dealId","tier"?,"amountCents"?,"milestone"?:"deposit","integrations"?[],"projectId"?,"daysUntilDue"?:7,"send"?:false}` | Reads the HubSpot deal (contact email and name, company), takes the tier from the body or "(Tier n)" in the deal name, gives the deal a project id (`ZP-<year>-<NNN>`, the next free one; the same deal always gets the same id, table `deal_projects`), and makes the invoice exactly like `/api/admin/invoices` (bank-only at $500+), plus metadata `hubspot_deal_id`. Amount defaults to the list price ($1,500 / $5,500 / $10,000); pass `amountCents` for a deposit or a bigger Tier 3. **Not emailed unless `"send": true`**, so you can check the hosted invoice first. Then `PATCH` the deal: `dealstage` = `HUBSPOT_INVOICE_STAGE` (`contractsent`), `amount`. `503` without `HUBSPOT_ACCESS_TOKEN` or `STRIPE_SECRET_KEY`, `502` HubSpot error. |
| `POST /api/admin/sessions/:projectId/maintenance` | `{"requiredIntegrations"?[],"note"?}` | Launched projects only (`409` otherwise). `201 {"requestId","link","expiresAt","emailed","requiredIntegrations"}`. Keys default to the intake's list. Link works `MAINTENANCE_LINK_DAYS` (7); a newer link closes the older one. Emailed to approver and client when Resend is set up. |
| `GET /api/admin/sessions/:projectId/maintenance` | none | Last 20 re-auth requests (status, dates, `has_encrypted_secrets`), never the keys. |
| `POST /api/admin/maintenance/:id/done` | none | `200 {"status":"DONE","secretsPurgeAfter"}`: keys wiped `SECRETS_PURGE_DAYS` (7) from now, or sooner if already due. Otherwise they're wiped `MAINTENANCE_PURGE_DAYS` (14) after the client sends them. |
| `POST /api/admin/sessions/:projectId/testimonial-link` | none | Launched only. `200 {"testimonialId","status","link","expiresAt"}` (30 days), so you can send it yourself. |
| `GET /api/admin/testimonials?status=PENDING` | none | Up to 50 quotes in that status (`REQUESTED`, `PENDING`, `APPROVED`, `REJECTED`). |
| `POST /api/admin/testimonials/:id/approve` | `{"headline"?,"quote"?,"authorName"?,"authorRole"?,"company"?}` | `200 {"status":"APPROVED"}`. Only now does it show on zp-landing. Keep any edit true to what they wrote. |
| `POST /api/admin/testimonials/:id/reject` | none | `200 {"status":"REJECTED"}`. |
| `POST /api/admin/run-cron` | none | Runs housekeeping now; returns `{"secretsPurged","linksExpired","followupsRetried","maintenanceKeysPurged","maintenanceLinksExpired","milestones",…}`. |

### Slack and PandaDoc callbacks

| Method & path | Auth | What it does |
|---|---|---|
| `POST /api/slack/interactions` | Slack signature | The **Approve & Send Contract** button (`action_id: approve_send_contract`, `value: <project_id>`). Answers 200 at once, then sends the PandaDoc document and rewrites the Slack message (via Slack's `response_url`) to "✅ Contract sent … Approved by <name> (<Slack id>) at <time>". If `SLACK_CONTRACT_APPROVERS` is set, only those Slack member ids can approve. A double click sends once (the row is claimed `DRAFT_PENDING_APPROVAL → SENDING` first). |
| `POST /api/pandadoc/webhook` | PandaDoc signature | Event "Document state changed". `document.sent/viewed` → `SENT`; `document.completed` → `SIGNED` + `contract_signed_at`, then the signed PDF is downloaded (`GET /public/v1/documents/<id>/download`) into R2 and copied to the client's Drive through zp-landing; `document.declined` / `document.voided` → `DECLINED` / `VOIDED` (posted to #contract-approvals). A signed contract never moves back. |

### Cron (hourly, `17 * * * *`)

1. Wipes client API keys past their purge date.
2. Marks unfinished links past expiry as `EXPIRED`.
3. Retries Jira, the kickoff receipt and the zp-landing hand-off for up to 10 `CLOCK_RUNNING` or `IN_REVIEW` sessions where any of `jira_synced_at`, `receipt_sent_at`, `landing_synced_at` is empty.
4. Re-auth links: wipes re-entered keys past their purge date and closes unused links past expiry.
5. Client emails (`milestones.ts`, all no-ops without Resend: nothing sent, marked or logged):
   - **50%** on business day 3 of 5, 5 of 10, 10 of 20, while still `CLOCK_RUNNING`, to approver and client. No link in it: their private intake link shows the live status. Skipped (and logged `milestone.half_skipped`) if the sprint is already in review or past its deadline.
   - **100%** at the deadline: "today is delivery day" if still building, "sprint complete, ready for your sign-off" if in review. Skipped if the deadline passed more than 48 hours ago, so turning Resend on later can't send a backlog.
   - **Testimonial request** `TESTIMONIAL_DELAY_DAYS` (3) after launch, within 30 days, with a `/testimonial?token=…` link. Needs `PORTAL_URL` too (the cron has no address of its own); until then use the admin `testimonial-link` route.
   - **#sprint-ops "⏰ Deadline reached, staging not in review"** once per project at the deadline if still `CLOCK_RUNNING` (doesn't need Resend).
6. Contracts and launch (10 each): drafts for paid projects with no PandaDoc document yet (only sessions this version created, `amount_cents` set), signed PDFs not yet in R2 or Drive (Drive waits until `landing_synced_at`), and launches not yet marked Complete in Airtable.

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

### Stripe

- **Inbound:** Stripe → Developers → Webhooks: one endpoint, `<portal>/api/stripe/webhook`, event `invoice.paid` only; its signing secret is `STRIPE_WEBHOOK_SECRET`.
- **Outbound (new):** secret `STRIPE_SECRET_KEY`, a restricted key: Invoices **write**, Customers **write**, PaymentIntents **read**, Charges **read**. Used by the $500+ rail check (`GET /v1/invoice_payments`, `/v1/payment_intents/<id>`, `/v1/charges/<id>`, `/v1/invoices/<id>`) and `POST /api/admin/invoices` (`GET/POST /v1/customers`, `POST /v1/invoices`, `/v1/invoiceitems`, `/v1/invoices/<id>/finalize`, `/send`). Keep it a test key (`rk_test_…`) until you go live.
- For `customer_balance` (bank transfer / wire), Stripe shows the client a virtual bank account on the hosted invoice. Turn on **Bank transfers** and **ACH Direct Debit** under Settings → Payment methods.

### PandaDoc

- **Enabled by:** secrets `PANDADOC_API_KEY`, `PANDADOC_TEMPLATE_ID` (and `PANDADOC_WEBHOOK_KEY` for the webhook). Missing = contracts skipped.
- **Auth:** `Authorization: API-Key <PANDADOC_API_KEY>`.
- **Calls** (`https://api.pandadoc.com/public/v1`):
  - `GET /documents?metadata_project_id=<id>` first, so a retry reuses an existing document instead of making a second.
  - `POST /documents` `{name:"<project> · <legal name> · MSA + SOW", template_uuid, recipients:[{email, first_name, last_name, role:"Client"}], tokens:[…], metadata:{project_id, tier}, tags}`.
  - `GET /documents/<id>` before sending (a new document is `document.uploaded` for a few seconds; only `document.draft` can be sent).
  - `POST /documents/<id>/send` `{subject, message, silent:false}`.
  - `GET /documents/<id>/download` for the signed PDF.
- **Template tokens** (add these exact variable names to the template): `Client.CompanyName` (legal business name, else client name), `Client.ContactName`, `Client.Email`, `Project.ID`, `Project.Tier` ("Tier 2"), `Project.DeliveryBusinessDays` (5 / 10 / 20), `Project.Amount` ("$1,500.00"), `Project.StartDate` (the day the draft is made, e.g. "November 26, 2026"; the clock start once intake is in). The template needs one recipient role named `Client`.
- **D1:** `pandadoc_document_id`, `contract_status` (`DRAFT_PENDING_APPROVAL → SENDING → SENT → SIGNED`, or `DECLINED` / `VOIDED`), `contract_drafted_at`, `contract_approved_by`, `contract_sent_at`, `contract_signed_at`, `contract_r2_key`, `contract_drive_synced_at`.
- **R2 backup:** `zp-intake-assets/<project_id>/contracts/<project_id>-MSA-SOW-SIGNED.pdf`.

### Slack

Incoming webhooks, one per channel (`SLACK_WEBHOOK_REVENUE`, `SLACK_WEBHOOK_SPRINT_OPS`, `SLACK_WEBHOOK_APPROVALS`, `SLACK_WEBHOOK_ERRORS`, `SLACK_WEBHOOK_CONTRACTS`). The contract button needs the same Slack app's **Interactivity** turned on with Request URL `<portal>/api/slack/interactions`, and its signing secret as `SLACK_SIGNING_SECRET`. Messages never include an intake link or API keys. The one exception is the review link in #staging-approvals, posted so you can pass it on while email isn't set up: it works like a password for the launch sign-off.

### #worker-errors (shared with zp-landing)

`reportWorkerError(env, { service, step, projectId, status, detail })` in `src/services/errors.ts`, same shape as zp-landing's `src/errors.js`. `reportingFetch` wraps every outside call (Stripe, PandaDoc, Resend, Jira, zp-landing, GitHub), so any non-2xx answer or network failure posts one alert: service, method + path, project, status, and the first 600 characters of the error with keys, tokens and webhook URLs redacted. Normal answers are not alerts: GitHub 404 (no such account), zp-landing 409 (client not onboarded yet), PandaDoc 409 on send (still processing). Uncaught exceptions (`app.onError`) and a crashed cron post too. The same service | step | project | status posts once every 6 hours (table `worker_alerts`); the next post says how many repeats were skipped.

### Resend (email)

- **Enabled by:** secret `RESEND_API_KEY` **and** var `RECEIPT_FROM_EMAIL` (a sender on a Resend-verified domain; set to `intake@zinkpress.com` in `wrangler.toml`). If either is empty nothing is emailed; `AGENCY_EMAIL` (Proton) is never used as the sender because Resend rejects it. `AGENCY_EMAIL` is the `reply_to`.
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
| `DB` | D1 `zp-intake` (`dbe569b8-56f6-48db-9e8b-c0e50551e4c3`) | `onboarding_sessions` (one row per project, incl. `jira_synced_at`, `receipt_sent_at`, `landing_synced_at`, payment, KYB, contract and review columns from migration 0003), `audit_log` (key names only, never values), `stripe_events`, `worker_alerts` (alert de-dupe). `maintenance_requests`, `testimonials`, `deal_projects` (migration 0004). Migrations in `apps/worker/migrations`; apply with `npm run db:migrate:remote`. |
| `ASSETS_BUCKET` | R2 `zp-intake-assets` (private) | `<project_id>/assets/logo-<uuid>.<ext>` and `asset-<uuid>.<ext>`, custom metadata `originalName`, `sessionId`; signed contracts at `<project_id>/contracts/<project_id>-MSA-SOW-SIGNED.pdf`. |
| `[assets]` | `apps/web/dist` | The intake form (SPA); `/api/*` runs the Worker first. |
| cron | `17 * * * *` | Housekeeping above. |

## Audit log events

`milestone.half_sent`, `milestone.half_skipped`, `milestone.full_sent`, `milestone.full_skipped`, `maintenance.requested`, `maintenance.submitted`, `maintenance.done`, `testimonial.requested`, `testimonial.skipped`, `testimonial.link_issued`, `testimonial.submitted`, `testimonial.approved`, `testimonial.rejected`, `stripe.blocked_card_over_500`, `stripe.blocked_rail_over_500`, `stripe.rail_unverified`, `invoice.created`, `kyb.webmail_flagged`, `kyb.override`, `contract.drafted`, `contract.approval_requested`, `contract.approval_refused`, `contract.sent`, `contract.signed`, `contract.declined`, `contract.voided`, `contract.backed_up`, `contract.drive_synced`, `review.requested`, `review.approved`, `landing.completed`, `session.created`, `intake.emailed`, `asset.uploaded`, `clock.started`, `submit.blocked`, `jira.synced`, `jira.skipped`, `receipt.sent`, `receipt.skipped`, `landing.synced`, `landing.skipped`, `followup.failed`, `link.reissued`, `launched`, `stripe.ignored`, `cron`.

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
| `ZP_LANDING_ONBOARD_URL`, `ZP_LANDING_WEBHOOK_SECRET` | secrets | hand-off, signed contract to Drive, Airtable Complete | those steps skipped |
| `STRIPE_SECRET_KEY` | secret | $500+ rail check, `POST /api/admin/invoices` | $500+ invoices held (503, Stripe retries); invoice route 503 |
| `PANDADOC_API_KEY`, `PANDADOC_TEMPLATE_ID` | secrets | contracts | contracts skipped |
| `PANDADOC_WEBHOOK_KEY` | secret | PandaDoc webhook | every webhook call 401 |
| `SLACK_WEBHOOK_REVENUE`, `_SPRINT_OPS`, `_APPROVALS`, `_ERRORS`, `_CONTRACTS` | secrets | Slack posts | that channel skipped |
| `SLACK_SIGNING_SECRET` | secret | the Approve & Send button | every click 401 |
| `SLACK_CONTRACT_APPROVERS` | var | who may approve contracts | anyone in the channel |
| `AGENCY_NAME`, `AGENCY_EMAIL` | vars | email copy, reply-to, form | |
| `PORTAL_URL`, `ALLOWED_ORIGIN` | vars | link base, CORS | Worker's own address, same site only |
| `BUSINESS_TIMEZONE`, `HOLIDAYS` | vars | clock | America/New_York, no holidays |
| `TOKEN_TTL_DAYS`, `SECRETS_PURGE_DAYS` | vars | link life, key wipe | 14, 7 |
| `STAGING_URL_TEMPLATE`, `CLOUDFLARE_HELP_URL` | vars | receipt and form copy | |
| `MAINTENANCE_LINK_DAYS`, `MAINTENANCE_PURGE_DAYS` | vars | re-auth link life, re-entered key wipe | 7, 14 |
| `TESTIMONIAL_DELAY_DAYS` | var | testimonial request delay | 3 |
| `HUBSPOT_ACCESS_TOKEN` | secret | `POST /api/admin/invoices/from-deal` (same token as zp-landing; deals, contacts, companies read + deals write) | that route 503 |
| `HUBSPOT_INVOICE_STAGE` | var | deal stage after the invoice | `contractsent` |

Change vars in `wrangler.toml` (a deploy overwrites dashboard vars); add secrets in the dashboard.
