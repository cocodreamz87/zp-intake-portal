# CLAUDE.md: zp-intake-portal

Guidance for Claude Code in this repo. The full map, routes, settings and working rules are in [AGENTS.md](AGENTS.md), shared with every other AI agent. It is imported below so there is one copy.

@AGENTS.md

## Claude Code quick reference

- Run the tests before every PR: `npm run check   # after npm install, which needs her yes`
- Open a PR and stop there. Demetrius Moreland merges.
- Never run without her yes: merging a PR or pushing to `main`, `wrangler deploy` (or `npm run deploy`), `wrangler secret put`, `wrangler d1 migrations apply --remote` (`npm run db:migrate:remote`), anything in a Cloudflare, Stripe, Slack, HubSpot, PandaDoc or Resend dashboard.
- Secrets: names only, never values, in anything you write.
