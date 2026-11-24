import { z } from "zod";
import { GITHUB_NAME_RE } from "./github";

/**
 * One schema, used by BOTH the browser wizard and the Worker.
 * The browser uses it to unlock the "Start Sprint Clock" button.
 * The Worker uses it again on submit, because a browser can be bypassed.
 *
 * Checkboxes use refine() instead of z.literal(true, { errorMap }),
 * because errorMap changed between Zod 3 and Zod 4. This repo pins Zod 4.
 */

export const TIERS = ["TIER_1", "TIER_2", "TIER_3"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABELS: Record<Tier, string> = {
  TIER_1: "Tier 1 · Launch (up to 5 pages)",
  TIER_2: "Tier 2 · Growth (site + integrations)",
  TIER_3: "Tier 3 · Custom portal",
};

export const REGISTRARS = ["Cloudflare", "Namecheap", "GoDaddy", "Squarespace", "Other"] as const;

export const SESSION_STATUSES = [
  "AWAITING_CREDENTIALS",
  "CLOCK_RUNNING",
  "LAUNCHED",
  "EXPIRED",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
export const SECRET_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Words that mean "not final yet". Zero Placeholder Policy. */
const PLACEHOLDER_RE = /(lorem ipsum|\bTBD\b|\bTBA\b|\[insert|placeholder|\bXXX+\b|coming soon)/i;

const mustBeChecked = (message: string) =>
  z.boolean().refine((v) => v === true, message);

const email = (message: string) =>
  z.string().trim().max(254).regex(EMAIL_RE, message);

const finalText = (label: string, max = 500) =>
  z
    .string()
    .trim()
    .min(2, `${label} is required.`)
    .max(max, `${label} is too long (max ${max} characters).`)
    .refine((v) => !PLACEHOLDER_RE.test(v), `${label} still has placeholder text. Send final copy only.`);

const httpsUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "Enter a full https:// link to your Google Doc or Notion page.");

export const CopySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("link"), url: httpsUrl }),
  z.object({
    mode: z.literal("fields"),
    heroHeadline: finalText("Hero headline", 120),
    subheadline: finalText("Subheadline", 240),
    services: z.array(finalText("Service", 300)).length(3, "List exactly 3 core services."),
    contactInfo: finalText("Contact info", 500),
  }),
]);

export const FontSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("system") }),
  z.object({
    mode: z.literal("google"),
    family: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9 ]{2,60}$/, "Type the Google Font name exactly, for example: Inter"),
  }),
]);

export const SecretsSchema = z
  .record(
    z.string().regex(SECRET_KEY_RE, "Key names use CAPITAL_LETTERS_AND_UNDERSCORES."),
    z.string().trim().min(1, "A key can't be blank.").max(4096, "That value is too long."),
  )
  .refine((obj) => Object.keys(obj).length <= 25, "Up to 25 keys per project.");

export interface IntakeContext {
  tier: Tier;
  /** Key names the contract requires, for example STRIPE_SECRET_KEY. Tier 2/3 only. */
  requiredIntegrations: string[];
}

export function buildIntakeSchema(ctx: IntakeContext) {
  const needsIntegrations = ctx.tier !== "TIER_1";

  return z
    .object({
      // Step 1: Infrastructure & DNS
      registrarProvider: z.enum(REGISTRARS, "Pick your domain registrar."),
      registrarDelegatedConfirmed: mustBeChecked("Confirm you gave our team access at your registrar."),
      cloudflareAdminConfirmed: mustBeChecked("Confirm you added our team as a Cloudflare Administrator."),
      githubTarget: z
        .string()
        .trim()
        .regex(GITHUB_NAME_RE, "Enter a real GitHub username or organization (letters, numbers, single hyphens)."),

      // Step 2: Brand & content
      logoKey: z.string().min(1, "Upload your logo (.SVG, .EPS, or transparent .PNG at least 1000px wide)."),
      primaryHex: z.string().regex(HEX_RE, "Primary color must be a 6-digit hex code like #0F172A."),
      secondaryHex: z.string().regex(HEX_RE, "Secondary color must be a 6-digit hex code like #22D3EE."),
      font: FontSchema,
      copy: CopySchema,
      copyFinalizedConfirmed: mustBeChecked("Confirm your copy is final and proofread."),

      // Step 3: Integrations (Tier 2/3)
      secrets: SecretsSchema.default({}),
      adminEmails: z.array(email("Each admin email must be a real email address.")).max(10).default([]),

      // Step 4: Single point of contact
      spocName: z.string().trim().min(2, "Enter the approver's full name.").max(120),
      spocEmail: email("Enter the approver's email address."),
    })
    .superRefine((data, issue) => {
      if (!needsIntegrations) {
        if (Object.keys(data.secrets).length > 0) {
          issue.addIssue({ code: "custom", path: ["secrets"], message: "Tier 1 projects don't take API keys." });
        }
        return;
      }
      for (const key of ctx.requiredIntegrations) {
        if (!data.secrets[key]) {
          issue.addIssue({ code: "custom", path: ["secrets", key], message: `${key} is required for your contract.` });
        }
      }
      if (data.adminEmails.length === 0) {
        issue.addIssue({
          code: "custom",
          path: ["adminEmails"],
          message: "Add at least one admin email for your portal.",
        });
      }
    });
}

export type IntakePayload = z.infer<ReturnType<typeof buildIntakeSchema>>;

/** Which top-level fields belong to which wizard step (for per-step checkmarks). */
export const STEP_FIELDS: Record<1 | 2 | 3 | 4, string[]> = {
  1: ["registrarProvider", "registrarDelegatedConfirmed", "cloudflareAdminConfirmed", "githubTarget"],
  2: ["logoKey", "primaryHex", "secondaryHex", "font", "copy", "copyFinalizedConfirmed"],
  3: ["secrets", "adminEmails"],
  4: ["spocName", "spocEmail"],
};

/** Turns Zod issues into { "copy.url": "message" } for the form. */
export function flattenIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>) {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const key = i.path.map(String).join(".") || "_form";
    if (!out[key]) out[key] = i.message;
  }
  return out;
}

/** What GET /api/session returns to the wizard. */
export interface SessionView {
  projectId: string;
  clientName: string;
  tier: Tier;
  status: SessionStatus;
  requiredIntegrations: string[];
  agencyName: string;
  agencyEmail: string;
  cloudflareHelpUrl: string;
  /** IANA zone the clock runs in, e.g. America/New_York. */
  timeZone: string;
  tokenExpiresAt: string;
  clockStartedAt: string | null;
  guaranteedDeadline: string | null;
}

export interface SubmitResult {
  clockStartedAt: string;
  guaranteedDeadline: string;
}
