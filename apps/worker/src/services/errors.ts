/**
 * #worker-errors alerts, shared shape with zp-landing's src/errors.js.
 *
 * reportWorkerError() posts one formatted alert to SLACK_WEBHOOK_ERRORS.
 * reportingFetch() wraps fetch so every external API call (Stripe, PandaDoc, Resend,
 * Jira, zp-landing, which in turn covers Drive, Airtable and HubSpot) reports any
 * non-2xx answer or network failure on its own.
 *
 * Rules:
 *  - Never throws, never changes the answer the caller gets.
 *  - The same signature (service | step | project | status) posts at most once every
 *    ALERT_REPEAT_HOURS, so hourly cron retries don't flood the channel. Repeats in
 *    between are counted and shown on the next post.
 *  - Never includes request bodies, headers, tokens, links or API keys: only the
 *    service, step (method + path), project id, HTTP status and the first part of
 *    the error text the service sent back.
 */
import type { Env } from "../env";
import { sendSlackAlert } from "./slack";

export interface WorkerErrorReport {
  /** Stripe, PandaDoc, Resend, Jira, zp-landing, GitHub, zp-intake-portal, ... */
  service: string;
  /** What we were doing, e.g. "POST /v1/invoices" or "cron". */
  step: string;
  projectId?: string | null;
  /** HTTP status, or "exception" / "network". */
  status: number | string;
  detail?: string;
}

export const ALERT_REPEAT_HOURS = 6;
const MAX_DETAIL = 600;

/** Strip anything that looks like a credential before it goes to Slack. */
export function redact(text: string): string {
  return String(text)
    .replace(/(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, "$1_$2_[redacted]")
    .replace(/whsec_[A-Za-z0-9]+/g, "whsec_[redacted]")
    .replace(/re_[A-Za-z0-9_]{16,}/g, "re_[redacted]")
    .replace(/https:\/\/hooks\.slack\.com\/[^\s"']+/g, "https://hooks.slack.com/[redacted]")
    .replace(/(token=)[A-Za-z0-9_-]{20,}/gi, "$1[redacted]")
    .replace(/(Bearer|API-Key|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]");
}

function signature(r: WorkerErrorReport) {
  return [r.service, r.step, r.projectId ?? "-", String(r.status)].join(" | ").slice(0, 300);
}

/** Posts one alert to #worker-errors. Returns whether it posted. Never throws. */
export async function reportWorkerError(env: Env, r: WorkerErrorReport, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    if (!env.SLACK_WEBHOOK_ERRORS) {
      console.error(`[worker-error] ${signature(r)} ${redact(r.detail ?? "").slice(0, MAX_DETAIL)}`);
      return false;
    }
    let suppressed = 0;
    const sig = signature(r);
    if (env.DB) {
      try {
        const prev = await env.DB.prepare("SELECT last_sent_at, suppressed FROM worker_alerts WHERE signature = ?")
          .bind(sig)
          .first<{ last_sent_at: string; suppressed: number }>();
        const now = Date.now();
        if (prev && now - Date.parse(prev.last_sent_at) < ALERT_REPEAT_HOURS * 3_600_000) {
          await env.DB.prepare("UPDATE worker_alerts SET suppressed = suppressed + 1 WHERE signature = ?").bind(sig).run();
          return false;
        }
        suppressed = prev?.suppressed ?? 0;
        await env.DB.prepare(
          `INSERT INTO worker_alerts (signature, last_sent_at, suppressed) VALUES (?, ?, 0)
           ON CONFLICT(signature) DO UPDATE SET last_sent_at = excluded.last_sent_at, suppressed = 0`,
        )
          .bind(sig, new Date(now).toISOString())
          .run();
      } catch (err) {
        // The table may not exist yet (migration not applied). Alert anyway.
        console.error("worker_alerts lookup failed:", err instanceof Error ? err.message : String(err));
      }
    }
    const res = await sendSlackAlert(
      env,
      {
        channel: "ERRORS",
        title: `🔴 ${r.service} error: ${r.step}`.slice(0, 150),
        fields: [
          { label: "Service", value: r.service },
          { label: "Step", value: r.step },
          { label: "Project", value: r.projectId || "none" },
          { label: "Status", value: String(r.status) },
          { label: "Worker", value: "zp-intake-portal" },
          { label: "Time", value: new Date().toISOString() },
        ],
        note:
          redact(r.detail ?? "").slice(0, MAX_DETAIL) +
          (suppressed ? `\n(${suppressed} repeat${suppressed === 1 ? "" : "s"} in the last ${ALERT_REPEAT_HOURS} hours not posted)` : ""),
      },
      fetchImpl,
    );
    return res.sent;
  } catch (err) {
    console.error("reportWorkerError failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Which service a URL belongs to. Slack itself is never reported (that would loop). */
export function serviceForUrl(url: string, env: Env): string | null {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return "unknown";
  }
  if (host === "hooks.slack.com" || host === "slack.com" || host.endsWith(".slack.com")) return null;
  if (host === "api.stripe.com") return "Stripe";
  if (host === "api.pandadoc.com") return "PandaDoc";
  if (host === "api.resend.com") return "Resend";
  if (host === "api.github.com") return "GitHub";
  if (host.endsWith(".atlassian.net") || (env.JIRA_DOMAIN && host === env.JIRA_DOMAIN)) return "Jira";
  for (const u of [env.ZP_LANDING_ONBOARD_URL]) {
    try {
      if (u && new URL(u).hostname === host) return "zp-landing";
    } catch {
      /* ignore */
    }
  }
  return host;
}

export interface ReportingOptions {
  projectId?: string | null;
  /** Statuses that are normal answers for this caller, e.g. GitHub's 404 for "no such user". */
  expected?: (service: string, status: number, url: string) => boolean;
  /** Runs the Slack post in the background (ctx.waitUntil) instead of awaiting it. */
  defer?: (p: Promise<unknown>) => void;
}

/** Normal non-2xx answers that are not errors. */
export function defaultExpected(service: string, status: number, url: string): boolean {
  // GitHub 404 = "no account with that name", which the intake form shows to the client.
  if (service === "GitHub" && status === 404) return true;
  // zp-landing 409 = "client not onboarded yet" or "already running"; the cron retries.
  if (service === "zp-landing" && status === 409) return true;
  // PandaDoc 409 on send = document still processing; the next click/retry succeeds.
  if (service === "PandaDoc" && status === 409 && /\/send$/.test(new URL(url).pathname)) return true;
  return false;
}

/**
 * A fetch that reports every non-2xx answer and every network failure to #worker-errors,
 * then hands the original response (or error) back unchanged.
 */
export function reportingFetch(env: Env, base: typeof fetch, opts: ReportingOptions = {}): typeof fetch {
  const expected = opts.expected ?? defaultExpected;
  const run = (p: Promise<unknown>) => (opts.defer ? opts.defer(p) : p);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method || (typeof input === "object" && "method" in input ? input.method : "GET") || "GET").toUpperCase();
    const service = serviceForUrl(url, env);
    let step = method;
    try {
      step = `${method} ${new URL(url).pathname}`;
    } catch {
      /* keep method only */
    }
    try {
      const res = await base(input as any, init);
      if (service && !res.ok && !expected(service, res.status, url)) {
        const detail = await res.clone().text().catch(() => "");
        await run(reportWorkerError(env, { service, step, projectId: opts.projectId, status: res.status, detail }, base));
      }
      return res;
    } catch (err) {
      if (service) {
        await run(
          reportWorkerError(
            env,
            { service, step, projectId: opts.projectId, status: "network", detail: err instanceof Error ? err.message : String(err) },
            base,
          ),
        );
      }
      throw err;
    }
  }) as typeof fetch;
}
