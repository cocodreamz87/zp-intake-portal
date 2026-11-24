import { isValidGithubName } from "@zinkpress/shared";

export type GithubCheck =
  | { status: "exists"; type: "User" | "Organization"; login: string }
  | { status: "not_found" }
  | { status: "invalid" }
  /** GitHub didn't answer (rate limit, outage). We let the client continue and flag it for you. */
  | { status: "unverified"; reason: string };

/**
 * Format check first, then a real lookup on GitHub's public API.
 * /users/{name} answers for both people and organizations.
 * Without a token GitHub allows about 60 lookups per hour per IP, so set
 * GITHUB_TOKEN (a fine-grained token with no permissions is enough) in production.
 */
export async function checkGithubAccount(
  name: string,
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubCheck> {
  const login = name.trim();
  if (!isValidGithubName(login)) return { status: "invalid" };
  try {
    const res = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "zp-intake-portal",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (res.status === 404) return { status: "not_found" };
    if (!res.ok) return { status: "unverified", reason: `GitHub answered ${res.status}` };
    const body = (await res.json()) as { login?: string; type?: string };
    const type = body.type === "Organization" ? "Organization" : "User";
    return { status: "exists", type, login: body.login ?? login };
  } catch (err) {
    return { status: "unverified", reason: err instanceof Error ? err.message : "network error" };
  }
}
