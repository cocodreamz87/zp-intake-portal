/**
 * GitHub's own rules for user and organization names:
 * 1 to 39 characters, letters, numbers and single hyphens,
 * and it cannot start or end with a hyphen.
 * This is only the format check. The Worker also asks GitHub
 * whether the account really exists (see apps/worker/src/github.ts).
 */
export const GITHUB_NAME_RE = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/;

export function isValidGithubName(name: string): boolean {
  return GITHUB_NAME_RE.test(name.trim());
}
