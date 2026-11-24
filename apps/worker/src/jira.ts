import type { Tier } from "@zinkpress/shared";
import type { Env } from "./env";

export interface JiraProvisionInput {
  projectId: string;
  clientName: string;
  tier: Tier;
  githubTarget: string;
  registrarProvider: string;
  copySummary: string;
  spocName: string;
  spocEmail: string;
  guaranteedDeadline: string;
  /** YYYY-MM-DD in the business time zone. */
  dueDate: string;
  /** If we already created the epic on an earlier try, its key. */
  knownEpicKey?: string | null;
}

export interface JiraProvisionResult {
  epicKey: string;
  createdTasks: number;
  existingTasks: number;
}

const BASE_TASKS = [
  "Provision private GitHub repository & Cloudflare Pages/Workers CI/CD pipeline",
  "Configure Cloudflare security headers, edge caching & R2 brand asset imports",
  "Build core React + Vite + TypeScript views with final proofread copy",
  "Deploy staging preview URL & send consolidated review notice to SPOC",
  "Run final DNS cutover & transfer GitHub repository ownership once balance clears",
];

const TIER2_TASKS = [
  "Implement Cloudflare D1/KV schema & serverless Worker API endpoints",
  "Configure authentication & third-party API/webhook integrations",
];

const TIER3_TASKS = [
  "Build custom portal roles, admin accounts & access rules",
  "Write portal admin handbook & record walkthrough video",
];

export function taskSummariesFor(tier: Tier): string[] {
  if (tier === "TIER_1") return [...BASE_TASKS];
  const extra = tier === "TIER_2" ? TIER2_TASKS : [...TIER2_TASKS, ...TIER3_TASKS];
  return [...BASE_TASKS.slice(0, 2), ...extra, ...BASE_TASKS.slice(2)];
}

/** Every issue for a project carries this label, which is how a retry finds what already exists. */
export function projectLabel(projectId: string): string {
  return `zp-${projectId.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
}

function jqlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

/**
 * Creates the Epic and its tasks, safely re-runnable.
 *
 * The original snippet created the Epic, then bulk-created tasks. If the bulk
 * call failed and the Worker retried, you'd get a second Epic. Here every step
 * looks first and only creates what's missing:
 *   1. Use the epic key saved in D1, or search Jira for the project label.
 *   2. Create the Epic only if neither finds one.
 *   3. List the Epic's children and bulk-create only the missing task summaries.
 * The caller saves the epic key to D1 right after step 2 succeeds.
 */
export async function provisionJiraSprint(
  env: Env,
  input: JiraProvisionInput,
  onEpicKey: (key: string) => Promise<void> = async () => {},
  fetchImpl: typeof fetch = fetch,
): Promise<JiraProvisionResult> {
  const base = `https://${env.JIRA_DOMAIN}/rest/api/3`;
  const headers = {
    Authorization: `Basic ${btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`)}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const projectKey = env.JIRA_PROJECT_KEY!;
  const label = projectLabel(input.projectId);
  const epicType = env.JIRA_EPIC_TYPE || "Epic";
  const taskType = env.JIRA_TASK_TYPE || "Task";

  async function call<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Jira ${path} failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
    return (await res.json()) as T;
  }

  async function search(jql: string, max = 100) {
    const data = await call<{ issues?: Array<{ key: string; fields?: { summary?: string } }> }>("/search/jql", {
      jql,
      fields: ["summary"],
      maxResults: max,
    });
    return data.issues ?? [];
  }

  // 1 + 2. Find or create the Epic.
  let epicKey = input.knownEpicKey ?? null;
  if (!epicKey) {
    const found = await search(
      `project = ${jqlString(projectKey)} AND labels = ${jqlString(label)} AND issuetype = ${jqlString(epicType)}`,
      1,
    );
    epicKey = found[0]?.key ?? null;
  }
  if (!epicKey) {
    const created = await call<{ key: string }>("/issue", {
      fields: {
        project: { key: projectKey },
        issuetype: { name: epicType },
        summary: `[${input.projectId}] ${input.clientName} · ${input.tier.replace("_", " ")} Sprint`,
        duedate: input.dueDate,
        labels: [input.tier.toLowerCase().replace("_", "-"), "automated-intake", label],
        description: {
          type: "doc",
          version: 1,
          content: [
            paragraph(`Approver (SPOC): ${input.spocName} <${input.spocEmail}>`),
            paragraph(`GitHub target: ${input.githubTarget}`),
            paragraph(`Registrar: ${input.registrarProvider}`),
            paragraph(`Copy: ${input.copySummary}`),
            paragraph(`Guaranteed staging delivery: ${input.guaranteedDeadline}`),
            paragraph("Client API keys are encrypted in the intake portal. They are never copied into Jira."),
          ],
        },
      },
    });
    epicKey = created.key;
  }
  await onEpicKey(epicKey);

  // 3. Create only the tasks that aren't there yet.
  const wanted = taskSummariesFor(input.tier).map((s) => `[${input.projectId}] ${s}`);
  const existing = new Set(
    (await search(`parent = ${jqlString(epicKey)}`)).map((i) => i.fields?.summary ?? ""),
  );
  const missing = wanted.filter((s) => !existing.has(s));

  if (missing.length > 0) {
    const result = await call<{ issues?: unknown[]; errors?: Array<{ elementErrors?: unknown }> }>("/issue/bulk", {
      issueUpdates: missing.map((summary) => ({
        fields: {
          project: { key: projectKey },
          parent: { key: epicKey },
          issuetype: { name: taskType },
          summary,
          duedate: input.dueDate,
          labels: [label],
        },
      })),
    });
    // Jira's bulk endpoint can return 201 with some items failed. Treat that as a failure
    // so the retry job tries again; already-created tasks will be skipped next time.
    if (result.errors && result.errors.length > 0) {
      throw new Error(`Jira bulk create partly failed: ${JSON.stringify(result.errors).slice(0, 500)}`);
    }
  }

  return { epicKey, createdTasks: missing.length, existingTasks: wanted.length - missing.length };
}
