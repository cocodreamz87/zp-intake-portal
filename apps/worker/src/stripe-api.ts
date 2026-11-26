/**
 * Calls to Stripe's API (needs STRIPE_SECRET_KEY, a restricted key is best):
 *   - find which payment rail paid an invoice (the $500+ bank-only rule)
 *   - create and send an invoice that only offers bank transfer at $500+
 *
 * Restricted key permissions: Invoices (write), Customers (write), Payment Intents (read),
 * Charges (read). Stays in test/sandbox mode until you swap in a live key.
 */
import type { Env } from "./env";

/** At or above this (cents), only bank rails are accepted. */
export const BANK_ONLY_CENTS = 50_000;

/**
 * Bank rails we accept at $500+. Stripe names:
 *  us_bank_account     ACH Direct Debit (Financial Connections)
 *  customer_balance    bank transfer / wire into the customer's Stripe cash balance
 *  ach_credit_transfer, ach_debit  older ACH types
 *  wire                listed in the spec; Stripe reports wires as customer_balance
 *  out_of_band         you marked the invoice paid by hand in Stripe (check, wire outside Stripe)
 */
export const BANK_RAILS = ["us_bank_account", "ach_debit", "ach_credit_transfer", "customer_balance", "wire", "out_of_band"] as const;
export const CARD_RAILS = ["card", "card_present", "link", "apple_pay", "google_pay"] as const;

export type RailResult =
  | { ok: true; rails: string[]; source: "event" | "api" | "out_of_band" }
  | { ok: false; reason: "no_api_key" | "no_payment_found" | "stripe_error"; detail?: string };

const STRIPE = "https://api.stripe.com";

function headers(env: Env, extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...extra };
}

async function stripeGet<T>(env: Env, path: string, fetchImpl: typeof fetch): Promise<{ status: number; body: T | null }> {
  const res = await fetchImpl(`${STRIPE}${path}`, { headers: headers(env) });
  const text = await res.text();
  let body: T | null = null;
  try {
    body = JSON.parse(text) as T;
  } catch {
    /* not json */
  }
  if (!res.ok && res.status !== 404) throw new Error(`Stripe GET ${path.split("?")[0]} failed (${res.status}): ${text.slice(0, 300)}`);
  return { status: res.status, body };
}

const idOf = (v: unknown): string | null =>
  typeof v === "string" ? v : v && typeof v === "object" && typeof (v as any).id === "string" ? (v as any).id : null;

function railFromCharge(ch: any): string | null {
  return typeof ch?.payment_method_details?.type === "string" ? ch.payment_method_details.type : null;
}

/**
 * Works out how an invoice was paid. Reads what the event already carries first,
 * then asks Stripe (invoice payments, then the PaymentIntent's latest charge).
 */
export async function resolvePaymentRails(env: Env, invoice: any, fetchImpl: typeof fetch = fetch): Promise<RailResult> {
  if (invoice?.paid_out_of_band === true) return { ok: true, rails: ["out_of_band"], source: "out_of_band" };

  // Already expanded on the event (older API versions put charge / payment_intent on the invoice).
  const fromEvent = [railFromCharge(invoice?.charge), railFromCharge(invoice?.payment_intent?.latest_charge)].filter(
    (r): r is string => Boolean(r),
  );
  if (fromEvent.length) return { ok: true, rails: fromEvent, source: "event" };

  if (!env.STRIPE_SECRET_KEY) return { ok: false, reason: "no_api_key" };

  try {
    const piIds = new Set<string>();
    const chargeIds = new Set<string>();
    const add = (pi: unknown, ch: unknown) => {
      const p = idOf(pi);
      const c = idOf(ch);
      if (p) piIds.add(p);
      if (c) chargeIds.add(c);
    };
    add(invoice?.payment_intent, invoice?.charge);
    for (const p of invoice?.payments?.data ?? []) add(p?.payment?.payment_intent, p?.payment?.charge);

    if (!piIds.size && !chargeIds.size && invoice?.id) {
      // Current API: payments live on InvoicePayment objects.
      const list = await stripeGet<{ data?: any[] }>(
        env,
        `/v1/invoice_payments?invoice=${encodeURIComponent(invoice.id)}&limit=10`,
        fetchImpl,
      );
      for (const p of list.body?.data ?? []) if (p?.status !== "canceled") add(p?.payment?.payment_intent, p?.payment?.charge);
      if (!piIds.size && !chargeIds.size) {
        // Older API: charge / payment_intent on the invoice itself.
        const inv = await stripeGet<any>(env, `/v1/invoices/${encodeURIComponent(invoice.id)}`, fetchImpl);
        add(inv.body?.payment_intent, inv.body?.charge);
        if (inv.body?.paid_out_of_band === true) return { ok: true, rails: ["out_of_band"], source: "out_of_band" };
      }
    }

    const rails: string[] = [];
    for (const id of piIds) {
      const pi = await stripeGet<any>(env, `/v1/payment_intents/${encodeURIComponent(id)}?expand[]=latest_charge`, fetchImpl);
      const r = railFromCharge(pi.body?.latest_charge) ?? (pi.body?.payment_method_types?.length === 1 ? pi.body.payment_method_types[0] : null);
      if (r) rails.push(r);
    }
    for (const id of chargeIds) {
      const ch = await stripeGet<any>(env, `/v1/charges/${encodeURIComponent(id)}`, fetchImpl);
      const r = railFromCharge(ch.body);
      if (r) rails.push(r);
    }
    if (!rails.length) return { ok: false, reason: "no_payment_found" };
    return { ok: true, rails: [...new Set(rails)], source: "api" };
  } catch (err) {
    return { ok: false, reason: "stripe_error", detail: err instanceof Error ? err.message : String(err) };
  }
}

export function isBankRail(rail: string) {
  return (BANK_RAILS as readonly string[]).includes(rail);
}
export function isCardRail(rail: string) {
  return (CARD_RAILS as readonly string[]).includes(rail);
}

/* ---------------------------- Create + send an invoice ---------------------------- */

/** Stripe's form encoding, including nested keys like payment_settings[payment_method_types][0]. */
export function stripeForm(obj: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" ? stripeForm(item as any, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === "object") stripeForm(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export interface NewInvoice {
  projectId: string;
  tier: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  integrations: string[];
  amountCents: number;
  currency: string;
  description: string;
  daysUntilDue: number;
  /** "deposit", "final", ... part of the idempotency key so a second invoice per project is possible. */
  milestone: string;
  send: boolean;
}

export interface CreatedInvoice {
  invoiceId: string;
  customerId: string;
  status: string;
  hostedInvoiceUrl: string | null;
  paymentMethodTypes: string[] | null;
  sent: boolean;
}

/** The payment_settings we put on an invoice. Cards are left out at $500+. */
export function invoicePaymentSettings(amountCents: number) {
  if (amountCents < BANK_ONLY_CENTS) return undefined; // Stripe uses your account's default methods
  return {
    payment_method_types: ["us_bank_account", "customer_balance"],
    payment_method_options: {
      customer_balance: { funding_type: "bank_transfer", bank_transfer: { type: "us_bank_transfer" } },
      us_bank_account: { verification_method: "automatic" },
    },
  };
}

export async function createAndSendInvoice(env: Env, inv: NewInvoice, fetchImpl: typeof fetch = fetch): Promise<CreatedInvoice> {
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
  const keyBase = `zp-${inv.projectId}-${inv.milestone}-${inv.amountCents}`;

  async function post<T>(path: string, body: Record<string, unknown>, idem?: string): Promise<T> {
    const res = await fetchImpl(`${STRIPE}${path}`, {
      method: "POST",
      headers: headers(env, {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(idem ? { "Idempotency-Key": idem } : {}),
      }),
      body: stripeForm(body).toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Stripe POST ${path} failed (${res.status}): ${text.slice(0, 400)}`);
    return JSON.parse(text) as T;
  }

  // 1. Reuse the customer with this email, or make one.
  const found = await stripeGet<{ data?: Array<{ id: string }> }>(
    env,
    `/v1/customers?email=${encodeURIComponent(inv.contactEmail)}&limit=1`,
    fetchImpl,
  );
  const customerId =
    found.body?.data?.[0]?.id ??
    (
      await post<{ id: string }>(
        "/v1/customers",
        { email: inv.contactEmail, name: inv.companyName, metadata: { contact_name: inv.contactName } },
        `${keyBase}-customer`,
      )
    ).id;

  const metadata = {
    project_id: inv.projectId,
    tier: inv.tier,
    company_name: inv.companyName,
    client_name: inv.companyName, // read by the invoice.paid webhook
    contact_name: inv.contactName,
    contact_email: inv.contactEmail,
    integrations: inv.integrations.join(","),
    milestone: inv.milestone,
  };

  // 2. Draft invoice with the bank-only payment settings, then 3. its line.
  const draft = await post<{ id: string }>(
    "/v1/invoices",
    {
      customer: customerId,
      collection_method: "send_invoice",
      days_until_due: inv.daysUntilDue,
      currency: inv.currency,
      auto_advance: false,
      description: inv.description,
      metadata,
      payment_settings: invoicePaymentSettings(inv.amountCents),
    },
    `${keyBase}-invoice`,
  );
  await post(
    "/v1/invoiceitems",
    { customer: customerId, invoice: draft.id, amount: inv.amountCents, currency: inv.currency, description: inv.description, metadata },
    `${keyBase}-item`,
  );

  // 4. Finalize, 5. send (Stripe emails the hosted invoice page to the customer).
  let final = await post<any>(`/v1/invoices/${encodeURIComponent(draft.id)}/finalize`, {}, `${keyBase}-finalize`);
  let sent = false;
  if (inv.send) {
    final = await post<any>(`/v1/invoices/${encodeURIComponent(draft.id)}/send`, {}, `${keyBase}-send`);
    sent = true;
  }
  return {
    invoiceId: draft.id,
    customerId,
    status: String(final.status ?? "open"),
    hostedInvoiceUrl: final.hosted_invoice_url ?? null,
    paymentMethodTypes: final.payment_settings?.payment_method_types ?? null,
    sent,
  };
}
