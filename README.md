# ZinkPress Intake Portal

**No Credentials, No Clock.** A client pays a Stripe invoice, gets a private link, and fills in a 4-step form. The delivery clock starts only when every answer checks out. Then the portal opens a Jira epic with tasks and emails the client a kickoff receipt. No kickoff call needed.

```
Stripe invoice.paid ──► Worker API ──► D1 (session, status, audit log)
                           │  ▲
     email with link ◄─────┘  │  R2 (logos and brand files)
                              │
Client ──► Intake wizard (Cloudflare Pages) ──► submit ──► clock starts
                                                    ├──► Jira epic + tasks
                                                    └──► kickoff receipt email
```

| Folder | What it is |
|---|---|
| `apps/web` | The 4-step wizard (React + Vite + TypeScript). Deploys to Cloudflare Pages. |
| `apps/worker` | The API (Hono on Cloudflare Workers) with D1, R2, Web Crypto, cron. |
| `apps/worker/migrations` | The D1 database schema. |
| `packages/shared` | The Zod form rules, used by both the wizard and the API so they always agree. |

## How the clock works

- **Time zone:** Eastern (`America/New_York`). It follows daylight saving on its own, so it's EST in winter and EDT in summer. To change it, edit `BUSINESS_TIMEZONE` in `apps/worker/wrangler.toml`. That one setting drives everything.
- **Kickoff:** the next 9:00 AM Eastern on a business day, at or after the moment the client submits. Submit Tuesday 7:30 AM, kickoff is Tuesday 9:00 AM. Submit Tuesday 9:05 AM or Friday night, kickoff is the next business morning.
- **Business days:** Monday to Friday, minus the dates in `HOLIDAYS` (edit that list to your own days off).
- **Deadlines:** Tier 1 = 2 business days (the "48 hours"), Tier 2 = 5 business days, Tier 3 = 10 business days, each landing at 9:00 AM Eastern.

## What's different from the pasted spec (and why)

1. **Deadline used the wrong clock.** Workers run in UTC, so `setHours(9)` meant 9 AM in London (4 or 5 AM in Atlanta), and the weekday check read the UTC day, so Friday evening in Atlanta counted as Saturday. The new code does all math in Eastern time. Tests cover daylight saving in March and November.
2. **Deadline always added a day.** Submitting at 7 AM on a Tuesday pushed kickoff to Wednesday. Now a business-day morning before 9 AM kicks off that same morning.
3. **"48 hours" vs "2 business days".** I chose 2 business days, so a Thursday kickoff is due Monday 9 AM instead of Saturday 9 AM. That keeps your weekends free, which was the stated goal. If you'd rather promise true 48 clock hours, it's one line in `apps/worker/src/schedule.ts`.
4. **R2 presigned URLs.** Those need separate S3-style access keys that the spec never set up. Uploads now go through the Worker straight into R2 using the built-in binding, so there are no extra keys, and the Worker checks the actual file bytes first (real PNG, at least 1000px wide, transparent; real SVG with no scripts; real EPS).
5. **The link token was just the row id.** Now it's 256 random bits that can't be guessed. Only its hash is stored. It expires after 14 days (`TOKEN_TTL_DAYS`), is removed from the address bar as soon as the page loads, and is sent in a header, not in the URL path. You can reissue a fresh link anytime.
6. **Zod `errorMap` syntax.** `z.literal(true, { errorMap })` breaks between Zod versions. Checkboxes now use a plain `refine`, which works on Zod 3 and 4.
7. **Secrets textarea accepted anything.** There's no raw JSON box anymore. The wizard shows one password field per key your contract needs (from the invoice's `integrations` metadata), plus "Add another key" rows. Names must be `CAPITAL_SNAKE_CASE`, checked on both sides.
8. **No Stripe signature check.** Anyone who found the webhook URL could fake a paid invoice. The Worker now verifies `Stripe-Signature` (HMAC-SHA256), rejects events older than 5 minutes, and ignores repeat deliveries of the same event.
9. **Jira could double the epic on a retry.** Every issue gets a project label. A retry finds the existing epic (saved in D1 or found by label) and creates only the missing tasks. Failed Jira or email work is retried by the hourly cron job.
10. **GitHub check was only a length check.** It now uses GitHub's real name rules, then asks GitHub's API whether the account exists. If GitHub is down, the client can still submit and the row is marked unverified for you.
11. **Secrets purge wasn't built.** When you mark a project launched, the encrypted keys are wiped 7 days later (`SECRETS_PURGE_DAYS`) by the cron job.
12. **Smaller fixes:** encryption is bound to the project id (a blob copied to another row won't decrypt); two quick submits can't start two clocks; secrets never go into Jira, emails, or the audit log (key names only); the copy step rejects placeholder text like "Lorem ipsum" or "TBD"; `STRIPE_SECRET_KEY` isn't needed (the portal only receives webhooks); Jira's due date uses the Eastern date, not the UTC date.

## Run it on your computer

You need Node.js 22.13 or newer.

```bash
npm install
npm run check            # type-check, run all tests, build the wizard
```

To click through it locally:

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # then fill in the two REPLACE_WITH values
npm run db:migrate:local --workspace apps/worker
npm run dev:worker       # API on http://localhost:8787
npm run dev:web          # wizard on http://localhost:5173 (in a second terminal)
```

Make a test intake link (use the ADMIN_API_TOKEN from your `.dev.vars`):

```bash
curl -X POST http://localhost:8787/api/admin/sessions \
  -H "Authorization: Bearer YOUR_ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"projectId":"ZP-TEST-1","tier":"TIER_1","clientEmail":"you@example.com","clientName":"Test Client"}'
```

Open the `link` it prints.

## Deploy checklist (step by step)

Do these in order. Each step says what to type or click. Anything in `CAPS_LIKE_THIS` is a name you type exactly.

### 1. Get the tools ready
1. Install Node.js 22 or newer from nodejs.org.
2. Open a terminal in this folder and run `npm install`.
3. Run `npx wrangler login`. A browser window opens. Sign in to Cloudflare and click **Allow**.

### 2. Database and file storage (already done)
The `zp-intake` database and the `zp-intake-assets` file storage are already set up in your Cloudflare account, with all tables loaded, and the database ID is already in `apps/worker/wrangler.toml`. Go on to step 3.

If you ever need to rebuild them from scratch: `npx wrangler d1 create zp-intake`, paste the new `database_id` into `apps/worker/wrangler.toml`, run `npm run db:migrate:remote --workspace apps/worker`, then `npx wrangler r2 bucket create zp-intake-assets`. Keep the bucket private.

### 3. Put the API online
1. Run `cd apps/worker`.
2. Make your secret keys. For each line, run the command, then paste the value when it asks:
   - `openssl rand -base64 32` → copy the result → `npx wrangler secret put SECRETS_ENCRYPTION_KEY` → paste.
   - `openssl rand -hex 32` → copy the result → `npx wrangler secret put ADMIN_API_TOKEN` → paste. **Save this one in your password manager.** It's how you create links by hand.
   - On Windows, run these in Git Bash (it comes with Git and includes `openssl`).
3. Run `npx wrangler deploy`. It prints your API address, like `https://zp-intake-api.YOURNAME.workers.dev`. Copy it.
4. **Never lose `SECRETS_ENCRYPTION_KEY`.** If it changes, keys clients already sent can't be read.

### 4. Put the wizard online (Cloudflare Pages)
1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Pages → Connect to Git**.
2. Pick the `zp-intake-portal` repository.
3. Settings:
   - Build command: `npm run build`
   - Build output folder: `apps/web/dist`
   - Environment variables: `VITE_API_BASE` = your API address from step 3.3 (no slash at the end), and `NODE_VERSION` = `22`
4. Click **Save and Deploy**. It gives you a Pages address, like `https://zp-intake.pages.dev`.
5. Back in `apps/worker/wrangler.toml`, put that Pages address in both `PORTAL_URL` and `ALLOWED_ORIGIN`.
6. Run `npx wrangler deploy` again (from `apps/worker`) so the API knows where the wizard lives.

### 5. Connect Stripe
1. In Stripe, go to **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: your API address + `/api/stripe/webhook`.
3. Event to send: `invoice.paid` only.
4. Save, then click **Reveal** under Signing secret and copy it (starts with `whsec_`).
5. From the `apps/worker` folder, run `npx wrangler secret put STRIPE_WEBHOOK_SECRET` and paste it.
6. On every client invoice, add **Metadata** (on the invoice, not the customer):
   - `project_id` → your SOW number, like `ZP-2026-014`
   - `tier` → `TIER_1`, `TIER_2`, or `TIER_3`
   - `integrations` → (Tier 2/3 only) the key names they owe you, comma-separated, like `STRIPE_SECRET_KEY,RESEND_API_KEY`
   - `client_name` → optional; otherwise the customer name is used
7. Test it: in Stripe **test mode**, send yourself an invoice with the metadata above and pay it with the test card `4242 4242 4242 4242`. Then check the project with the admin command below. (`stripe trigger invoice.paid` from the Stripe CLI also proves the signature works, but its sample invoice doesn't carry your metadata, so the portal logs it and ignores it.)

### 6. Emails (Resend) — needs a domain
Resend only sends from a domain you own and verify. A Proton address can't be the sender.
- **Until you have a domain:** skip this. Make links with the admin command below and send them from your Proton email yourself.
- **Once you have a domain:** verify it in Resend, create an API key, run `npx wrangler secret put RESEND_API_KEY`, set `RECEIPT_FROM_EMAIL` in `wrangler.toml` to something like `intake@yourdomain.com`, and deploy again. `AGENCY_EMAIL` stays as the reply-to.

### 7. Jira (optional)
1. Create an API token at id.atlassian.com → Security → API tokens.
2. In `wrangler.toml`, set `JIRA_DOMAIN` (like `zinkpress.atlassian.net`) and `JIRA_PROJECT_KEY` (like `ZP`).
3. Run `npx wrangler secret put JIRA_EMAIL` (your Atlassian login) and `npx wrangler secret put JIRA_API_TOKEN`.
4. Deploy again. If your Jira project calls its types something other than Epic and Task, change `JIRA_EPIC_TYPE` and `JIRA_TASK_TYPE`.

### 8. Slack alerts (optional)
The Worker can post to four channels in your ZinkPress Slack. Each alert is skipped until its webhook URL is set, and a Slack problem never breaks a Stripe webhook or a client's submit.

| Channel | Secret | What posts there |
|---|---|---|
| #pipeline-revenue | `SLACK_WEBHOOK_REVENUE` | Invoice paid: client, project, tier, the real amount from Stripe, whether the intake link was emailed. |
| #sprint-ops | `SLACK_WEBHOOK_SPRINT_OPS` | Sprint clock started (kickoff and staging deadline in Eastern time), Jira epic ready (with a button), and an 8:17 AM check: a heads-up when 2 or more sprints are running, and a list of clients who've had their link over 48 hours without submitting. |
| #staging-approvals | `SLACK_WEBHOOK_APPROVALS` | Nothing yet. Saved for the approve-staging buttons, which need a separate Slack app. |
| #worker-errors | `SLACK_WEBHOOK_ERRORS` | Any 500 error (route plus the first lines of the error), and Jira or receipt follow-ups that fail (once per new error, not every hourly retry). |

Slack messages never include a client's intake link or their API keys.

Set it up:
1. Go to https://api.slack.com/apps, click **Create New App** → **From scratch**, name it "ZinkPress Alerts", pick the ZinkPress workspace.
2. Open **Incoming Webhooks**, turn it on, click **Add New Webhook to Workspace**, pick `#pipeline-revenue`, and click **Allow**. Copy the URL.
3. Repeat step 2 for `#sprint-ops`, `#staging-approvals` and `#worker-errors`. Each channel gets its own URL.
4. From `apps/worker`, run each of these and paste the matching URL when it asks:
   - `npx wrangler secret put SLACK_WEBHOOK_REVENUE`
   - `npx wrangler secret put SLACK_WEBHOOK_SPRINT_OPS`
   - `npx wrangler secret put SLACK_WEBHOOK_APPROVALS`
   - `npx wrangler secret put SLACK_WEBHOOK_ERRORS`
5. Treat these URLs like passwords: anyone who has one can post to that channel.

### 9. Optional extras
- `npx wrangler secret put GITHUB_TOKEN` with a fine-grained GitHub token that has no permissions. It raises GitHub's lookup limit from 60 to 5,000 an hour.
- A nicer address like `intake.yourdomain.com`: in Pages → Custom domains. Then update `PORTAL_URL` and `ALLOWED_ORIGIN` and deploy again.

Every `npx wrangler ...` command in steps 5 to 8 runs from the `apps/worker` folder.

## Your admin commands

Replace `API` with your API address and `TOKEN` with your `ADMIN_API_TOKEN`.

| What | Command |
|---|---|
| Start an intake without Stripe (cash, Zelle, testing) | `curl -X POST API/api/admin/sessions -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -d '{"projectId":"ZP-1","tier":"TIER_1","clientEmail":"c@x.com","clientName":"Name"}'` |
| See a project (no secrets shown) | `curl API/api/admin/sessions/ZP-1 -H "Authorization: Bearer TOKEN"` |
| New link (lost or expired) | `curl -X POST API/api/admin/sessions/ZP-1/reissue -H "Authorization: Bearer TOKEN"` |
| Mark launched (starts the 7-day key purge) | `curl -X POST API/api/admin/sessions/ZP-1/launched -H "Authorization: Bearer TOKEN"` |
| Run housekeeping now | `curl -X POST API/api/admin/run-cron -H "Authorization: Bearer TOKEN"` |

Reading a client's API keys is deliberately not an API route, so a leaked admin token can't pull them out. When you need them, run this on your own computer from `apps/worker`:

```bash
SECRETS_ENCRYPTION_KEY="your key" node scripts/reveal-secrets.mjs ZP-2026-014
```

## Tests

`npm test` runs 57 tests: the clock math (including daylight saving and holidays), the form rules, Stripe signatures, encryption, file checks, GitHub checks, Jira retry safety, and the whole API flow against a real copy of the database schema. No test calls Stripe, Jira, Resend, or GitHub for real.
