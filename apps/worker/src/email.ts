import type { Env } from "./env";

/** HTML-escapes anything a client typed before it goes into an email. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function formatInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Resend drops a second send with the same key, so a retry can't email twice. */
  idempotencyKey: string;
}

export async function sendEmail(env: Env, args: SendArgs, fetchImpl: typeof fetch = fetch): Promise<string> {
  // Callers check resendConfigured() first; never fall back to AGENCY_EMAIL (Resend rejects it).
  if (!env.RECEIPT_FROM_EMAIL) throw new Error("RECEIPT_FROM_EMAIL is not set");
  const from = `${env.AGENCY_NAME} <${env.RECEIPT_FROM_EMAIL}>`;
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": args.idempotencyKey,
    },
    body: JSON.stringify({
      from,
      to: [args.to],
      reply_to: env.AGENCY_EMAIL,
      subject: args.subject,
      html: args.html,
      text: args.text,
    }),
  });
  if (!res.ok) throw new Error(`Resend failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { id?: string };
  return body.id ?? "";
}

function shell(env: Env, inner: string) {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:auto;color:#0f172a">
<p style="font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4f46e5">${esc(env.AGENCY_NAME)}</p>
${inner}
<p style="color:#64748b;font-size:13px;margin-top:32px">Questions? Reply to this email or write to ${esc(env.AGENCY_EMAIL)}.</p>
</div>`;
}

export function intakeLinkEmail(env: Env, p: { clientName: string; projectId: string; link: string; expiresAt: string }) {
  const tz = env.BUSINESS_TIMEZONE || "America/New_York";
  const expires = formatInZone(p.expiresAt, tz);
  return {
    subject: `${env.AGENCY_NAME}: start your project ${p.projectId}`,
    html: shell(
      env,
      `<h1 style="font-size:22px">Payment received. One step left.</h1>
<p>Hi ${esc(p.clientName)}, thanks for your payment. Your delivery clock starts the moment your intake form is complete.</p>
<p><a href="${esc(p.link)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Open my intake form</a></p>
<p style="font-size:13px;color:#64748b">This private link works until ${esc(expires)}. Don't forward it.</p>`,
    ),
    text: `Hi ${p.clientName}, thanks for your payment.\nYour delivery clock starts when your intake form is complete:\n${p.link}\nThis private link works until ${expires}.`,
  };
}

export function kickoffReceiptEmail(
  env: Env,
  p: { clientName: string; projectId: string; clockStartedAt: string; guaranteedDeadline: string },
) {
  const tz = env.BUSINESS_TIMEZONE || "America/New_York";
  const kickoff = formatInZone(p.clockStartedAt, tz);
  const deadline = formatInZone(p.guaranteedDeadline, tz);
  const staging = env.STAGING_URL_TEMPLATE
    ? env.STAGING_URL_TEMPLATE.replace("{project}", encodeURIComponent(p.projectId.toLowerCase()))
    : null;
  const stagingHtml = staging
    ? `<p>Your staging preview will appear at <a href="${esc(staging)}">${esc(staging)}</a>.</p>`
    : "";
  return {
    subject: `${env.AGENCY_NAME}: sprint clock started for ${p.projectId}`,
    html: shell(
      env,
      `<h1 style="font-size:22px">Your sprint clock is running</h1>
<p>Hi ${esc(p.clientName)}, everything checked out. Project <strong>${esc(p.projectId)}</strong> is in our build queue.</p>
<table style="border-collapse:collapse;margin:16px 0">
<tr><td style="padding:6px 16px 6px 0;color:#64748b">Official kickoff</td><td style="padding:6px 0;font-weight:600">${esc(kickoff)}</td></tr>
<tr><td style="padding:6px 16px 6px 0;color:#64748b">Guaranteed staging delivery</td><td style="padding:6px 0;font-weight:600">${esc(deadline)}</td></tr>
</table>${stagingHtml}
<p>Your approver will get one consolidated review link when staging is ready.</p>`,
    ),
    text: `Hi ${p.clientName}, project ${p.projectId} is in our build queue.\nOfficial kickoff: ${kickoff}\nGuaranteed staging delivery: ${deadline}${staging ? `\nStaging preview: ${staging}` : ""}`,
  };
}

export function reviewReadyEmail(
  env: Env,
  p: { clientName: string; projectId: string; link: string; stagingUrl: string; expiresAt: string },
) {
  const tz = env.BUSINESS_TIMEZONE || "America/New_York";
  const expires = formatInZone(p.expiresAt, tz);
  return {
    subject: `${env.AGENCY_NAME}: your site is ready for review (${p.projectId})`,
    html: shell(
      env,
      `<h1 style="font-size:22px">Your staging site is ready</h1>
<p>Hi ${esc(p.clientName)}, project <strong>${esc(p.projectId)}</strong> is built and waiting for your review.</p>
<p>Your review page has a short walkthrough video, the staging link and the release notes. When you're happy, approve the launch there.</p>
<p><a href="${esc(p.link)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Review and approve</a></p>
<p style="font-size:13px;color:#64748b">This private link works until ${esc(expires)}. Don't forward it: whoever has it can approve your launch.</p>`,
    ),
    text: `Hi ${p.clientName}, project ${p.projectId} is ready for your review.\nReview and approve the launch here:\n${p.link}\nThis private link works until ${expires}. Don't forward it.`,
  };
}
