import { hmacSha256Hex, timingSafeEqual } from "./crypto";

/**
 * Checks the Stripe-Signature header the way Stripe documents it:
 *   header looks like  t=1700000000,v1=abc123...,v1=...
 *   expected v1 = HMAC-SHA256(webhook signing secret, `${t}.${rawBody}`)
 * Without this, anyone who finds the webhook URL could fake a "paid" invoice.
 * We also reject events older than 5 minutes so a captured request can't be replayed later.
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s?.trim());
    if (k === "t" && v) timestamp = Number(v);
    if (k === "v1" && v) signatures.push(v);
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return signatures.some((sig) => timingSafeEqual(sig, expected));
}

/** The parts of a Stripe invoice.paid event we use. */
export interface PaidInvoiceInfo {
  eventId: string;
  invoiceId: string;
  projectId: string;
  tier: string;
  clientName: string;
  clientEmail: string;
  requiredIntegrations: string[];
  /** From metadata contact_name (the person who signs). Falls back to the client name. */
  contactName: string;
  /** The raw invoice object, for the payment-rail check. */
  invoice: any;
  /** Amount paid in Stripe's smallest unit (cents for USD). Null if Stripe didn't send it. */
  amountPaid: number | null;
  currency: string | null;
}

/**
 * Pulls what we need out of invoice.paid. Put these on the invoice's metadata in Stripe:
 *   project_id     e.g. ZP-2026-014       (required)
 *   tier           TIER_1 | TIER_2 | TIER_3 (required)
 *   company_name   optional (client_name also works), falls back to the customer name on the invoice
 *   contact_name   optional, the person who signs the contract
 *   contact_email  optional, falls back to the invoice's customer_email
 *   integrations   optional, comma list of key names, e.g. STRIPE_SECRET_KEY,RESEND_API_KEY
 */
export function readPaidInvoice(event: any): PaidInvoiceInfo | { error: string } {
  if (event?.type !== "invoice.paid") return { error: `ignored event type ${event?.type}` };
  const inv = event.data?.object ?? {};
  const md = inv.metadata ?? {};
  const projectId = String(md.project_id ?? "").trim();
  const tier = String(md.tier ?? "").trim().toUpperCase();
  const clientEmail = String(inv.customer_email ?? md.contact_email ?? "").trim();
  const clientName = String(md.company_name ?? md.client_name ?? inv.customer_name ?? "").trim();
  const contactName = String(md.contact_name ?? "").trim();
  if (!projectId) return { error: "invoice metadata is missing project_id" };
  if (!tier) return { error: "invoice metadata is missing tier" };
  if (!clientEmail) return { error: "invoice has no customer_email" };
  const requiredIntegrations = String(md.integrations ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return {
    eventId: String(event.id),
    invoiceId: String(inv.id),
    projectId,
    tier,
    clientName: clientName || clientEmail,
    clientEmail,
    contactName: contactName || clientName || clientEmail,
    invoice: inv,
    requiredIntegrations,
    amountPaid: typeof inv.amount_paid === "number" ? inv.amount_paid : null,
    currency: typeof inv.currency === "string" ? inv.currency : null,
  };
}
