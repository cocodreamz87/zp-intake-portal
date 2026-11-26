# ZinkPress Intake Portal

**No Credentials, No Clock.** A client pays a Stripe invoice, gets a private link, and fills in a 4-step form. The delivery clock starts only when every answer checks out. Then the portal opens a Jira epic with tasks and emails the client a kickoff receipt. No kickoff call needed.

```
Stripe invoice.paid ──► zp-intake-portal Worker ──► D1 (session, status, audit log)
                           │        ▲
     email with link ◄─────┘        │  R2 (logos and brand files)
                                    │
Client ──► intake form (same Worker) ──► submit ──► clock starts
                                              ├──► Jira epic + tasks
                                              └──► kickoff receipt email
```

One Cloudflare Worker does everything: `/api/...` addresses run the API, and every other address shows the intake form.

| Folder | What it is |
|---|---|
| `wrangler.toml` | The Worker's settings (database, storage, schedule, your agency details). |
| `apps/web` | The 4-step intake form (React + Vite + TypeScript). |
| `apps/worker` | The API (Hono) with D1, R2, Web Crypto, and the hourly cron job. |
| `apps/worker/migrations` | The D1 database schema. |
| `packages/shared` | The Zod form rules, used by both the form and the API so they always agree. |
| `scripts/reveal-secrets.mjs` | Shows one client's API keys on your own computer. |

## How the clock works

- **Time zone:** Eastern (`America/New_York`). It follows daylight saving on its own, so it's EST in winter and EDT in summer. To change it, edit `BUSINESS_TIMEZONE` in `wrangler.toml` (in the repo's top folder). That one setting drives everything.
- **Kickoff:** the next 9:00 AM Eastern on a business day, at or after the moment the client submits. Submit Tuesday 7:30 AM, kickoff is Tuesday 9:00 AM. Submit Tuesday 9:05 AM or Friday night, kickoff is the next business morning.
- **Business days:** Monday to Friday, minus the dates in `HOLIDAYS` in `wrangler.toml`. That list holds every US federal holiday for 2026 and 2027 on its observed weekday, plus the Friday after Thanksgiving, so Thanksgiving week is a 4-day weekend. Kickoff and the deadline never land on a weekend or a listed date. Delete a date to work it, add your own days off, and add 2028 before the end of 2027.
- **Deadlines:** Tier 1 = 5 business days (one working week), Tier 2 = 10 business days (the top of the 7 to 10 days sold), Tier 3 = 20 business days (the top of the 3 to 4 weeks sold), each landing at 9:00 AM Eastern.

## What's different from the pasted spec (and why)

1. **Deadline used the wrong clock.** Workers run in UTC, so `setHours(9)` meant 9 AM in London (4 or 5 AM in Atlanta), and the weekday check read the UTC day, so Friday evening in Atlanta counted as Saturday. The new code does all math in Eastern time. Tests cover daylight saving in March and November.
2. **Deadline always added a day.** Submitting at 7 AM on a Tuesday pushed kickoff to Wednesday. Now a business-day morning before 9 AM kicks off that same morning.
3. **Deadlines count business days, not clock hours.** Weekends and the dates in `HOLIDAYS` never count, so a Thursday kickoff never comes due on a Saturday. That keeps your weekends free, which was the stated goal. The day count for each tier is one line in `apps/worker/src/schedule.ts`.
4. **R2 presigned URLs.** Those need separate S3-style access keys that the spec never set up. Uploads now go through the Worker straight into R2 using the built-in binding, so there are no extra keys, and the Worker checks the actual file bytes first (real PNG, at least 1000px wide, transparent; real SVG with no scripts; real EPS).
5. **The link token was just the row id.** Now it's 256 random bits that can't be guessed. Only its hash is stored. It expires after 14 days (`TOKEN_TTL_DAYS`), is removed from the address bar as soon as the page loads, and is sent in a header, not in the URL path. You can reissue a fresh link anytime.
6. **Zod `errorMap` syntax.** `z.literal(true, { errorMap })` breaks between Zod versions. Checkboxes now use a plain `refine`, which works on Zod 3 and 4.
7. **Secrets textarea accepted anything.** There's no raw JSON box anymore. The wizard shows one password field per key your contract needs (from the invoice's `integrations` metadata), plus "Add another key" rows. Names must be `CAPITAL_SNAKE_CASE`, checked on both sides.
8. **No Stripe signature check.** Anyone who found the webhook URL could fake a paid invoice. The Worker now verifies `Stripe-Signature` (HMAC-SHA256), rejects events older than 5 minutes, and ignores repeat deliveries of the same event.
9. **Jira could double the epic on a retry.** Every issue gets a project label. A retry finds the existing epic (saved in D1 or found by label) and creates only the missing tasks. Failed Jira or email work is retried by the hourly cron job.
10. **GitHub check was only a length check.** It now uses GitHub's real name rules, then asks GitHub's API whether the account exists. If GitHub is down, the client can still submit and the row is marked unverified for you.
11. **Secrets purge wasn't built.** When you mark a project launched, the encrypted keys are wiped 7 days later (`SECRETS_PURGE_DAYS`) by the cron job.
12. **One Worker instead of Pages + Worker.** The form and the API ship together as one Cloudflare Worker, so Cloudflare can build and deploy it from GitHub on every push, there's no cross-site setup, and client links use the Worker's own address automatically.
13. **Smaller fixes:** encryption is bound to the project id (a blob copied to another row won't decrypt); two quick submits can't start two clocks; secrets never go into Jira, emails, or the audit log (key names only); the copy step rejects placeholder text like "Lorem ipsum" or "TBD"; `STRIPE_SECRET_KEY` isn't needed (the portal only receives webhooks); Jira's due date uses the Eastern date, not the UTC date.

## Run it on your computer

You need Node.js 22.13 or newer.

```bash
npm install
npm run check            # type-check, run all tests, build the form
```

To click through it locally:

```bash
cp .dev.vars.example .dev.vars      # then put two long random passwords in it
npm run db:migrate:local
npm run dev                         # form and API on http://localhost:8787
```

Make a test intake link (use the ADMIN_API_TOKEN from your `.dev.vars`):

```bash
curl -X POST http://localhost:8787/api/admin/sessions \
  -H "Authorization: Bearer YOUR_ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"projectId":"ZP-TEST-1","tier":"TIER_1","clientEmail":"you@example.com","clientName":"Test Client"}'
```

Open the `link` it prints. To work on the form with instant reloads, run `npm run dev:web` in a second terminal and use http://localhost:5173 instead.

## Deploy checklist (step by step)

Everything here happens in your web browser. No terminal needed.

### 1. Database and file storage (already done)
The `zp-intake` database and the `zp-intake-assets` file storage already exist in your Cloudflare account, with all tables loaded, and the database ID is already in `wrangler.toml`. Nothing to do.

### 2. Make two passwords
Open your password manager (Proton Pass works) and generate two random passwords, each **at least 32 characters**. Save them as:
- **ZinkPress portal encryption key.** This locks clients' API keys. **Never change it or lose it.** If it changes, keys clients already sent can't be read.
- **ZinkPress portal admin token.** This is how you create links by hand.

### 3. Connect the repo to Cloudflare
1. In the Cloudflare dashboard, open **Workers & Pages** and click **Create**.
2. Choose **Import a repository** (on the Workers tab). If asked, connect your GitHub account and allow Cloudflare to see `zp-intake-portal`.
3. Pick the `zp-intake-portal` repository.
4. Fill in the settings:
   - **Project name:** `zp-intake-portal` (it must match exactly)
   - **Build command:** `npm run build`
   - **Deploy command:** `npx wrangler deploy`
   - **Root directory:** leave it as `/`
   - Under **Build variables**, add `NODE_VERSION` = `22`
5. Click **Create and deploy**. Wait for the green check. It takes about a minute.
6. Your portal's address shows on the Worker's page, like `https://zp-intake-portal.YOURNAME.workers.dev`. Copy it.

From now on, every push to the `main` branch on GitHub redeploys the portal on its own.

### 4. Add the two passwords
1. In the dashboard, open the `zp-intake-portal` Worker, then **Settings → Variables and Secrets**.
2. Click **Add**. Type: **Secret**. Name: `SECRETS_ENCRYPTION_KEY`. Value: your encryption key from step 2. Save.
3. Click **Add** again. Type: **Secret**. Name: `ADMIN_API_TOKEN`. Value: your admin token. Save.
4. Click **Deploy** if Cloudflare asks.
5. Check it: open your portal address with `/api/health` on the end. You should see `{"ok":true}`.

### 5. Connect Stripe
1. In Stripe, go to **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: your portal address + `/api/stripe/webhook`.
3. Event to send: `invoice.paid` only.
4. Save, then click **Reveal** under Signing secret and copy it (starts with `whsec_`).
5. Back in Cloudflare, add one more Secret named `STRIPE_WEBHOOK_SECRET` with that value (same way as step 4).
6. On every client invoice, add **Metadata** (on the invoice, not the customer):
   - `project_id` → your SOW number, like `ZP-2026-014`
   - `tier` → `TIER_1`, `TIER_2`, or `TIER_3`
   - `integrations` → (Tier 2/3 only) the key names they owe you, comma-separated, like `STRIPE_SECRET_KEY,RESEND_API_KEY`
   - `client_name` → optional; otherwise the customer name is used
7. Test it: in Stripe **test mode**, send yourself an invoice with the metadata above and pay it with the test card `[REDACTED-PAN]`. Then check the project with the admin command below.

### 6. Emails (Resend), once you have a domain
Resend only sends from a domain you own and verify. A Proton address can't be the sender.
- **Until you have a domain:** skip this. Make links with the admin command below and send them from your Proton email yourself.
- **Once you have a domain:** verify it in Resend, create an API key, and add it in Cloudflare as a Secret named `RESEND_API_KEY`. In `wrangler.toml`, set `RECEIPT_FROM_EMAIL` to something like `intake@yourdomain.com` and push. `AGENCY_EMAIL` stays as the reply-to.

### 7. Jira (optional)
1. Create an API token at id.atlassian.com → Security → API tokens.
2. In `wrangler.toml`, set `JIRA_DOMAIN` (like `zinkpress.atlassian.net`) and `JIRA_PROJECT_KEY` (like `ZP`), then push.
3. In Cloudflare, add Secrets `JIRA_EMAIL` (your Atlassian login) and `JIRA_API_TOKEN`.
4. If your Jira project calls its types something other than Epic and Task, change `JIRA_EPIC_TYPE` and `JIRA_TASK_TYPE`.

### 8. Optional extras
- A Secret named `GITHUB_TOKEN` holding a fine-grained GitHub token with no permissions. It raises GitHub's lookup limit from 60 to 5,000 an hour.
- A nicer address like `intake.yourdomain.com`: on the Worker's page, **Settings → Domains & Routes → Add → Custom domain**. Then set `PORTAL_URL` in `wrangler.toml` to that address and push, so emailed links use it.

**This repo is public.** Put passwords and keys only in Cloudflare's Secrets, never in `wrangler.toml` or any file in the repo.

## Your admin commands

Replace `PORTAL` with your portal address and `TOKEN` with your admin token. These run in a terminal (on Windows, use PowerShell and type `curl.exe` instead of `curl`). Clients who pay through Stripe don't need any of this; their link is created for them.

| What | Command |
|---|---|
| Start an intake without Stripe (cash, Zelle, testing) | `curl -X POST PORTAL/api/admin/sessions -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -d '{"projectId":"ZP-1","tier":"TIER_1","clientEmail":"c@x.com","clientName":"Name"}'` |
| See a project (no secrets shown) | `curl PORTAL/api/admin/sessions/ZP-1 -H "Authorization: Bearer TOKEN"` |
| New link (lost or expired) | `curl -X POST PORTAL/api/admin/sessions/ZP-1/reissue -H "Authorization: Bearer TOKEN"` |
| Mark launched (starts the 7-day key purge) | `curl -X POST PORTAL/api/admin/sessions/ZP-1/launched -H "Authorization: Bearer TOKEN"` |
| Run housekeeping now | `curl -X POST PORTAL/api/admin/run-cron -H "Authorization: Bearer TOKEN"` |

Reading a client's API keys is deliberately not an API route, so a leaked admin token can't pull them out. When you need them, run this on your own computer from the repo's top folder (it asks you to sign in to Cloudflare the first time):

```bash
SECRETS_ENCRYPTION_KEY="your encryption key" node scripts/reveal-secrets.mjs ZP-2026-014
```

## Tests

`npm test` runs 59 tests: the clock math (including daylight saving and holidays), the form rules, Stripe signatures, encryption, file checks, GitHub checks, Jira retry safety, and the whole API flow against a real copy of the database schema. No test calls Stripe, Jira, Resend, or GitHub for real.
