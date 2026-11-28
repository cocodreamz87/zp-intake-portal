import type { SessionStatus, Tier } from "./intake";

/** The four steps the client sees on their status page. */
export const STATUS_STAGES = ["INTAKE_COMPLETE", "BUILDING", "STAGING_REVIEW", "LAUNCHED"] as const;
export type StatusStage = (typeof STATUS_STAGES)[number];

export const STATUS_STAGE_LABELS: Record<StatusStage, string> = {
  INTAKE_COMPLETE: "Intake complete",
  BUILDING: "Building",
  STAGING_REVIEW: "Staging review",
  LAUNCHED: "Launched",
};

/** What GET /api/status returns to the client's status page (same private link as the intake). */
export interface StatusView {
  projectId: string;
  clientName: string;
  tier: Tier;
  status: SessionStatus;
  /** Where the project is now. Null while the intake form isn't submitted yet. */
  stage: StatusStage | null;
  agencyName: string;
  agencyEmail: string;
  timeZone: string;
  clockStartedAt: string | null;
  guaranteedDeadline: string | null;
  businessDaysTotal: number | null;
  businessDaysElapsed: number | null;
  businessDaysLeft: number | null;
  /** 0 to 100. */
  percent: number | null;
  reviewRequestedAt: string | null;
  launchedAt: string | null;
}

/** What GET /api/maintenance returns to the re-auth page. */
export interface MaintenanceView {
  projectId: string;
  clientName: string;
  agencyName: string;
  agencyEmail: string;
  requiredIntegrations: string[];
  note: string | null;
  status: "OPEN" | "SUBMITTED" | "DONE" | "EXPIRED";
  expiresAt: string;
  submittedAt: string | null;
}

/** What GET /api/testimonial returns to the testimonial page. */
export interface TestimonialRequestView {
  projectId: string;
  clientName: string;
  agencyName: string;
  agencyEmail: string;
  status: "REQUESTED" | "PENDING" | "APPROVED" | "REJECTED";
  suggestedName: string | null;
  /** How long the sprint took, e.g. 10 for a Tier 2. */
  businessDays: number;
}

/** One approved quote, as GET /api/testimonials returns it (public, used by zp-landing). */
export interface PublicTestimonial {
  id: string;
  quote: string;
  authorName: string;
  authorRole: string | null;
  company: string | null;
  headline: string | null;
  tier: Tier;
  businessDays: number;
  linkUrl: string | null;
  approvedAt: string;
}

/** Limits shared by the testimonial form and the Worker. */
export const TESTIMONIAL_QUOTE_MIN = 20;
export const TESTIMONIAL_QUOTE_MAX = 400;
