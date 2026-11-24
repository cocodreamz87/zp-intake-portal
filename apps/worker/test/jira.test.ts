import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { projectLabel, provisionJiraSprint, taskSummariesFor } from "../src/jira";
import { fakeJira } from "./fakes";

const env = {
  JIRA_DOMAIN: "zinkpress.atlassian.net",
  JIRA_PROJECT_KEY: "ZP",
  JIRA_EMAIL: "me@example.com",
  JIRA_API_TOKEN: "test",
} as Env;

const input = {
  projectId: "ZP-2026-014",
  clientName: "Acme",
  tier: "TIER_1" as const,
  githubTarget: "acme",
  registrarProvider: "Namecheap",
  copySummary: "https://docs.google.com/document/d/x",
  spocName: "Jordan",
  spocEmail: "jordan@acme.com",
  guaranteedDeadline: "2026-11-26T14:00:00.000Z",
  dueDate: "2026-11-26",
};

describe("Jira provisioning", () => {
  it("creates one epic and the tier's tasks", async () => {
    const jira = fakeJira();
    const r = await provisionJiraSprint(env, input, async () => {}, jira.handle as unknown as typeof fetch);
    expect(r.createdTasks).toBe(5);
    expect(jira.issues.filter((i) => i.type === "Epic")).toHaveLength(1);
    expect(jira.issues.filter((i) => i.parent === r.epicKey)).toHaveLength(5);
    expect(jira.issues[0].labels).toContain(projectLabel(input.projectId));
  });

  it("running it again creates nothing new (no duplicate epic)", async () => {
    const jira = fakeJira();
    const f = jira.handle as unknown as typeof fetch;
    await provisionJiraSprint(env, input, async () => {}, f);
    const again = await provisionJiraSprint(env, input, async () => {}, f);
    expect(again.createdTasks).toBe(0);
    expect(again.existingTasks).toBe(5);
    expect(jira.issues.filter((i) => i.type === "Epic")).toHaveLength(1);
    expect(jira.issues).toHaveLength(6);
  });

  it("after a half-finished bulk create, the retry fills in only the missing tasks", async () => {
    const jira = fakeJira({ failBulkOnce: true });
    const f = jira.handle as unknown as typeof fetch;
    let saved: string | null = null;
    await expect(provisionJiraSprint(env, input, async (k) => void (saved = k), f)).rejects.toThrow(/504/);
    expect(saved).toBe("ZP-1"); // epic key saved before the tasks step
    const r = await provisionJiraSprint(env, { ...input, knownEpicKey: saved }, async () => {}, f);
    expect(r.createdTasks).toBe(3);
    expect(jira.issues.filter((i) => i.type === "Epic")).toHaveLength(1);
    expect(jira.issues.filter((i) => i.parent === "ZP-1")).toHaveLength(5);
  });

  it("Tier 2 and 3 get extra tasks", () => {
    expect(taskSummariesFor("TIER_1")).toHaveLength(5);
    expect(taskSummariesFor("TIER_2")).toHaveLength(7);
    expect(taskSummariesFor("TIER_3")).toHaveLength(9);
  });

  it("never puts client API keys in Jira", async () => {
    const jira = fakeJira();
    const bodies: string[] = [];
    const spy = (async (url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return jira.handle(url, init);
    }) as unknown as typeof fetch;
    await provisionJiraSprint(env, input, async () => {}, spy);
    expect(bodies.join("")).not.toMatch(/sk_(live|test)_/);
  });
});
