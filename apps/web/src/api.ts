import type { SessionView, SubmitResult } from "@zinkpress/shared";

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
  submit: (token: string, payload: unknown) =>
    call<SubmitResult>(token, "/api/onboarding/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
};
