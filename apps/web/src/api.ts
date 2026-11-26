import type {
  ApproveResult,
  MaintenanceView,
  ReviewView,
  SessionView,
  StatusView,
  SubmitResult,
  TestimonialRequestView,
} from "@zinkpress/shared";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public fields: Record<string, string> = {},
    public code?: string,
  ) {
    super(message);
  }
}

async function call<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.fields, body.code);
  return body as T;
}

export const api = {
  session: (token: string) => call<SessionView>(token, "/api/session"),
  checkGithub: (token: string, name: string) =>
    call<{ status: "exists" | "not_found" | "invalid" | "unverified"; type?: string; login?: string }>(
      token,
      `/api/github/check?name=${encodeURIComponent(name)}`,
    ),
  upload: (token: string, file: File, kind: "logo" | "asset") => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("kind", kind);
    return call<{ key: string; contentType: string; note: string | null }>(token, "/api/assets/upload", {
      method: "POST",
      body: fd,
    });
  },
  review: (token: string) => call<ReviewView>(token, "/api/review"),
  status: (token: string) => call<StatusView>(token, "/api/status"),
  maintenance: (token: string) => call<MaintenanceView>(token, "/api/maintenance"),
  submitMaintenance: (token: string, secrets: Record<string, string>) =>
    call<{ status: string; submittedAt: string }>(token, "/api/maintenance/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secrets }),
    }),
  testimonial: (token: string) => call<TestimonialRequestView>(token, "/api/testimonial"),
  submitTestimonial: (token: string, body: Record<string, unknown>) =>
    call<{ status: string }>(token, "/api/testimonial", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  approve: (token: string, body: { confirmed: boolean; signerName: string }) =>
    call<ApproveResult>(token, "/api/review/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  submit: (token: string, payload: unknown) =>
    call<SubmitResult>(token, "/api/onboarding/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
};
