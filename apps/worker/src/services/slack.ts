/**
 * Slack alerts for the intake Worker, sent through Slack "Incoming Webhooks"
 * (one webhook URL per channel, set as Worker secrets).
 *
 * Rules this file keeps:
 *  - A Slack problem never breaks the request that triggered it. Every send
 *    catches its own errors, logs a non-2xx answer, and returns a result
 *    instead of throwing. That way a Slack outage can't make a Stripe webhook
 *    fail and get retried.
 *  - If a channel's webhook URL isn't set, the send is skipped quietly.
 *  - Anything a client typed is escaped, so a name like "<!channel>" can't
 *    ping the whole workspace or turn into a link.
 *  - Never put an intake link, token, or client API key in a Slack message.
 */
import type { Env } from "../env";

export type SlackChannel = "REVENUE" | "SPRINT_OPS" | "APPROVALS" | "ERRORS";

/** Which secret holds the webhook URL for each channel. */
export const SLACK_WEBHOOK_VARS: Record<SlackChannel, keyof Env> = {
  REVENUE: "SLACK_WEBHOOK_REVENUE", // #pipeline-revenue
  SPRINT_OPS: "SLACK_WEBHOOK_SPRINT_OPS", // #sprint-ops
  APPROVALS: "SLACK_WEBHOOK_APPROVALS", // #staging-approvals
  ERRORS: "SLACK_WEBHOOK_ERRORS", // #worker-errors
};

export interface SlackAlert {
  channel: SlackChannel;
  title: string;
  fields?: { label: string; value: string }[];
  /** Optional longer note under the fields (plain text, escaped for you). */
  note?: string;
  /** Optional link buttons. Only https links are kept. */
  links?: { label: string; url: string }[];
}

export type SlackResult =
  | { sent: true }
  | { sent: false; reason: "not_configured" | "http_error" | "network_error"; status?: number };

// Slack's own limits for Block Kit pieces (we stay under them).
const MAX_HEADER = 150;
const MAX_FIELDS = 10;
const MAX_FIELD_TEXT = 2000;
const MAX_SECTION_TEXT = 3000;
const MAX_BUTTONS = 5;
const TIMEOUT_MS = 5000;

/** Slack mrkdwn treats &, < and > as control characters. */
export function slackEscape(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:" && url.length <= 3000;
  } catch {
    return false;
  }
}

/** Builds the Block Kit message. Exported so tests can check it. */
export function buildSlackMessage(alert: SlackAlert) {
  const title = clip(alert.title.trim() || "ZinkPress alert", MAX_HEADER);
  const fields = (alert.fields ?? []).filter((f) => f.value !== "").slice(0, MAX_FIELDS);
  const links = (alert.links ?? []).filter((l) => isHttps(l.url)).slice(0, MAX_BUTTONS);

  const blocks: unknown[] = [{ type: "header", text: { type: "plain_text", text: title, emoji: true } }];
  if (fields.length) {
    blocks.push({
      type: "section",
      fields: fields.map((f) => ({
        type: "mrkdwn",
        text: clip(`*${slackEscape(f.label)}:*\n${slackEscape(f.value)}`, MAX_FIELD_TEXT),
      })),
    });
  }
  if (alert.note) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(slackEscape(alert.note), MAX_SECTION_TEXT) } });
  }
  if (links.length) {
    blocks.push({
      type: "actions",
      elements: links.map((l, i) => ({
        type: "button",
        text: { type: "plain_text", text: clip(l.label, 75), emoji: true },
        url: l.url,
        ...(i === 0 ? { style: "primary" } : {}),
      })),
    });
  }

  // `text` is what shows in phone notifications and in clients that can't draw blocks.
  return { text: title, blocks };
}

/** Sends one alert. Never throws. */
export async function sendSlackAlert(env: Env, alert: SlackAlert, fetchImpl: typeof fetch = fetch): Promise<SlackResult> {
  const url = String(env[SLACK_WEBHOOK_VARS[alert.channel]] ?? "").trim();
  if (!url) return { sent: false, reason: "not_configured" };

  try {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildSlackMessage(alert)),
    };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      init.signal = AbortSignal.timeout(TIMEOUT_MS);
    }
    const res = await fetchImpl(url, init);
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      // Log the channel, never the webhook URL (the URL itself is the secret).
      console.error(`Slack ${alert.channel} alert failed: HTTP ${res.status} ${detail}`);
      return { sent: false, reason: "http_error", status: res.status };
    }
    return { sent: true };
  } catch (err) {
    console.error(`Slack ${alert.channel} alert failed:`, err instanceof Error ? err.message : String(err));
    return { sent: false, reason: "network_error" };
  }
}

/** True when at least one Slack channel has a webhook URL. */
export function slackConfigured(env: Env): boolean {
  return Object.values(SLACK_WEBHOOK_VARS).some((k) => Boolean(String(env[k] ?? "").trim()));
}

/** "$1,500.00" from Stripe's smallest-unit amount (cents for USD). */
export function formatMoney(amountMinor: number | null | undefined, currency: string | null | undefined): string {
  if (typeof amountMinor !== "number" || !Number.isFinite(amountMinor)) return "unknown amount";
  const cur = (currency || "usd").toUpperCase();
  // Currencies with no minor unit (Stripe's list of zero-decimal currencies).
  const zeroDecimal = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
  const value = zeroDecimal.has(cur) ? amountMinor : amountMinor / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(value);
  } catch {
    return `${value.toFixed(2)} ${cur}`;
  }
}

/** "Tier 1" from "TIER_1". */
export function tierLabel(tier: string): string {
  return tier.replace(/^TIER_/, "Tier ");
}
