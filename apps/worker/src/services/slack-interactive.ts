/**
 * Slack interactivity for #contract-approvals: the "Approve & Send Contract" button.
 *
 * The message goes out through the SLACK_WEBHOOK_CONTRACTS incoming webhook. When someone
 * clicks the button, Slack POSTs to /api/slack/interactions (the app's Interactivity
 * Request URL). We check Slack's signature with SLACK_SIGNING_SECRET, answer within
 * 3 seconds, send the contract in the background, then rewrite the original message
 * through the response_url Slack gave us to show who approved it and when.
 */
import { hmacSha256Hex, timingSafeEqual } from "../crypto";
import { slackEscape, tierLabel, formatMoney } from "./slack";

export const APPROVE_ACTION_ID = "approve_send_contract";

/**
 * Slack signs every request: X-Slack-Signature = "v0=" + HMAC-SHA256(signing secret,
 * "v0:<X-Slack-Request-Timestamp>:<raw body>"). Requests older than 5 minutes are refused,
 * so a captured click can't be replayed.
 */
export async function verifySlackSignature(
  rawBody: string,
  timestamp: string | null | undefined,
  sig: string | null | undefined,
  secret: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!secret || !timestamp || !sig || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  const expected = `v0=${await hmacSha256Hex(secret, `v0:${timestamp}:${rawBody}`)}`;
  return timingSafeEqual(sig, expected);
}

export interface ContractCard {
  projectId: string;
  clientName: string;
  contactName: string;
  contactEmail: string;
  tier: string;
  amountCents: number | null;
  currency: string | null;
  documentId: string;
}

export function pandadocDocUrl(documentId: string) {
  return `https://app.pandadoc.com/a/#/documents/${encodeURIComponent(documentId)}`;
}

function fieldsBlock(c: ContractCard) {
  return {
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*Project:*\n${slackEscape(c.projectId)}` },
      { type: "mrkdwn", text: `*Client:*\n${slackEscape(c.clientName)}` },
      { type: "mrkdwn", text: `*Signer:*\n${slackEscape(c.contactName)} (${slackEscape(c.contactEmail)})` },
      { type: "mrkdwn", text: `*Tier:*\n${slackEscape(tierLabel(c.tier))}` },
      { type: "mrkdwn", text: `*Amount:*\n${slackEscape(formatMoney(c.amountCents, c.currency))}` },
    ],
  };
}

/** The message posted to #contract-approvals when a draft is ready. */
export function contractApprovalMessage(c: ContractCard) {
  const title = `📝 Contract draft ready: ${c.projectId}`;
  return {
    text: title,
    blocks: [
      { type: "header", text: { type: "plain_text", text: title.slice(0, 150), emoji: true } },
      fieldsBlock(c),
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Check the filled-in MSA/SOW in PandaDoc first. Approving sends it to the client for signature right away.",
        },
      },
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Review draft in PandaDoc", emoji: true }, url: pandadocDocUrl(c.documentId) },
          {
            type: "button",
            style: "primary",
            action_id: APPROVE_ACTION_ID,
            value: c.projectId,
            text: { type: "plain_text", text: "Approve & Send Contract", emoji: true },
            confirm: {
              title: { type: "plain_text", text: "Send this contract?" },
              text: { type: "mrkdwn", text: `PandaDoc emails it to ${slackEscape(c.contactEmail)} for signature.` },
              confirm: { type: "plain_text", text: "Send it" },
              deny: { type: "plain_text", text: "Not yet" },
            },
          },
        ],
      },
    ],
  };
}

/** What replaces the message after a click. */
export function contractResultMessage(
  c: ContractCard,
  outcome: { ok: true; approver: string; at: string } | { ok: false; approver: string; reason: string },
) {
  const title = outcome.ok ? `✅ Contract sent: ${c.projectId}` : `⚠️ Contract not sent: ${c.projectId}`;
  const line = outcome.ok
    ? `Approved by ${slackEscape(outcome.approver)} at ${slackEscape(outcome.at)}. PandaDoc emailed it to ${slackEscape(c.contactEmail)}.`
    : `${slackEscape(outcome.approver)} clicked Approve, but it didn't send: ${slackEscape(outcome.reason)}`;
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: title.slice(0, 150), emoji: true } },
    fieldsBlock(c),
    { type: "section", text: { type: "mrkdwn", text: line } },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Open in PandaDoc", emoji: true }, url: pandadocDocUrl(c.documentId) },
        ...(outcome.ok
          ? []
          : [
              {
                type: "button",
                style: "primary",
                action_id: APPROVE_ACTION_ID,
                value: c.projectId,
                text: { type: "plain_text", text: "Try again", emoji: true },
              },
            ]),
      ],
    },
  ];
  return { replace_original: true, text: title, blocks };
}

/** Rewrites the clicked message. Only Slack's own hooks.slack.com response URLs are used. */
export async function updateSlackMessage(responseUrl: string, message: unknown, fetchImpl: typeof fetch = fetch) {
  try {
    const u = new URL(responseUrl);
    if (u.protocol !== "https:" || u.hostname !== "hooks.slack.com") return false;
    const res = await fetchImpl(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    return res.ok;
  } catch (err) {
    console.error("Slack message update failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}
