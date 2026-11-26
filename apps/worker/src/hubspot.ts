import type { Tier } from "@zinkpress/shared";
import type { Env } from "./env";

const HUBSPOT = "https://api.hubapi.com";

export interface DealForInvoice {
  dealId: string;
  dealName: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  /** Tier the lead picked on the landing form, read from the deal name ("… (Tier 2)"). */
  tierInterest: Tier | null;
}

async function hs<T>(env: Env, path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(`${HUBSPOT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HubSpot ${init.method ?? "GET"} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Reads a scoping deal (made by zp-landing when a lead filled the form) and its first contact
 * and company, so the invoice can be prefilled. Throws if the deal has no contact with an email.
 */
export async function readDealForInvoice(env: Env, dealId: string, fetchImpl: typeof fetch): Promise<DealForInvoice> {
  const deal = await hs<any>(
    env,
    `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=dealname&associations=contacts,companies`,
    { method: "GET" },
    fetchImpl,
  );
  const contactId = deal?.associations?.contacts?.results?.[0]?.id;
  if (!contactId) throw new Error("This deal has no contact attached in HubSpot.");
  const contact = await hs<any>(env, `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=email,firstname,lastname,company`, { method: "GET" }, fetchImpl);
  const companyId = deal?.associations?.companies?.results?.[0]?.id;
  const company = companyId
    ? await hs<any>(env, `/crm/v3/objects/companies/${encodeURIComponent(companyId)}?properties=name`, { method: "GET" }, fetchImpl)
    : null;
  const email = String(contact?.properties?.email ?? "").trim().toLowerCase();
  if (!email) throw new Error("This deal's contact has no email in HubSpot.");
  const contactName = [contact?.properties?.firstname, contact?.properties?.lastname].filter(Boolean).join(" ").trim();
  const companyName =
    String(company?.properties?.name ?? contact?.properties?.company ?? "").trim() || contactName || email;
  const m = /\(Tier ([123])\)/i.exec(String(deal?.properties?.dealname ?? ""));
  const tier = m ? `TIER_${m[1]}` : "";
  return {
    dealId: String(deal.id ?? dealId),
    dealName: String(deal?.properties?.dealname ?? ""),
    companyName,
    contactName: contactName || companyName,
    contactEmail: email,
    tierInterest: tier === "TIER_1" || tier === "TIER_2" || tier === "TIER_3" ? tier : null,
  };
}

/** After the invoice exists: move the deal to the "invoice sent" stage and record the amount. */
export async function markDealInvoiced(
  env: Env,
  p: { dealId: string; projectId: string; amountCents: number; invoiceUrl: string | null },
  fetchImpl: typeof fetch,
) {
  const properties: Record<string, string> = {
    dealstage: env.HUBSPOT_INVOICE_STAGE || "contractsent",
    amount: (p.amountCents / 100).toFixed(2),
    description: `ZinkPress project ${p.projectId}. Stripe invoice: ${p.invoiceUrl ?? "draft (not sent yet)"}`.slice(0, 1000),
  };
  return hs(env, `/crm/v3/objects/deals/${encodeURIComponent(p.dealId)}`, { method: "PATCH", body: JSON.stringify({ properties }) }, fetchImpl);
}
