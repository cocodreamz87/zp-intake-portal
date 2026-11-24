/**
 * Test stand-ins for Cloudflare D1 and R2, so the full API can be exercised
 * in plain Node with the real SQL migration. Nothing here talks to the network.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../migrations/0001_init.sql", import.meta.url)), "utf8"));

  const statement = (sql: string, params: unknown[] = []): any => ({
    bind: (...p: unknown[]) => statement(sql, p),
    async run() {
      const r = db.prepare(sql).run(...(params as any[]));
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) }, results: [] };
    },
    async first(col?: string) {
      const row = db.prepare(sql).get(...(params as any[])) as Record<string, unknown> | undefined;
      if (!row) return null;
      return col ? row[col] : { ...row };
    },
    async all() {
      const rows = db.prepare(sql).all(...(params as any[]));
      return { success: true, meta: {}, results: rows.map((r) => ({ ...(r as object) })) };
    },
  });

  return {
    prepare: (sql: string) => statement(sql),
    async batch(stmts: any[]) {
      return Promise.all(stmts.map((s) => s.run()));
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    _raw: db,
  } as unknown as D1Database;
}

export function fakeR2() {
  const store = new Map<string, { bytes: Uint8Array; contentType?: string; custom?: Record<string, string> }>();
  const bucket = {
    async put(key: string, value: Uint8Array, opts?: any) {
      store.set(key, { bytes: value, contentType: opts?.httpMetadata?.contentType, custom: opts?.customMetadata });
      return { key };
    },
    async head(key: string) {
      return store.has(key) ? { key, size: store.get(key)!.bytes.length } : null;
    },
    async get(key: string) {
      const v = store.get(key);
      return v ? { key, arrayBuffer: async () => v.bytes.buffer } : null;
    },
    async list({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) {
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((key) => ({ key }));
      return { objects, truncated: false };
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, store };
}

/** A pretend Jira project kept in memory. `failBulkOnce` simulates a flaky bulk create. */
export function fakeJira(opts: { failBulkOnce?: boolean } = {}) {
  let next = 1;
  let failBulk = opts.failBulkOnce ?? false;
  const issues: Array<{ key: string; type: string; summary: string; labels: string[]; parent?: string }> = [];
  const calls: string[] = [];

  async function handle(url: string, init: RequestInit): Promise<Response> {
    const path = new URL(url).pathname.replace("/rest/api/3", "");
    const body = JSON.parse(String(init.body ?? "{}"));
    calls.push(path);
    if (path === "/search/jql") {
      const jql: string = body.jql;
      let found = issues;
      const label = /labels = "([^"]+)"/.exec(jql)?.[1];
      const type = /issuetype = "([^"]+)"/.exec(jql)?.[1];
      const parent = /parent = "([^"]+)"/.exec(jql)?.[1];
      if (label) found = found.filter((i) => i.labels.includes(label));
      if (type) found = found.filter((i) => i.type === type);
      if (parent) found = found.filter((i) => i.parent === parent);
      return Response.json({ issues: found.slice(0, body.maxResults ?? 50).map((i) => ({ key: i.key, fields: { summary: i.summary } })) });
    }
    if (path === "/issue") {
      const f = body.fields;
      const key = `ZP-${next++}`;
      issues.push({ key, type: f.issuetype.name, summary: f.summary, labels: f.labels ?? [] });
      return Response.json({ key }, { status: 201 });
    }
    if (path === "/issue/bulk") {
      const updates: any[] = body.issueUpdates;
      if (failBulk) {
        failBulk = false;
        // Create the first two, then "fail" - like a timeout halfway through.
        for (const u of updates.slice(0, 2)) {
          issues.push({ key: `ZP-${next++}`, type: u.fields.issuetype.name, summary: u.fields.summary, labels: u.fields.labels, parent: u.fields.parent.key });
        }
        return new Response("gateway timeout", { status: 504 });
      }
      const created = updates.map((u) => {
        const key = `ZP-${next++}`;
        issues.push({ key, type: u.fields.issuetype.name, summary: u.fields.summary, labels: u.fields.labels, parent: u.fields.parent.key });
        return { key };
      });
      return Response.json({ issues: created, errors: [] }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  }

  return { issues, calls, handle };
}

/** Builds a tiny PNG header (enough for our checks; pixel data isn't needed). */
export function fakePng(width: number, colorType: number, withTrns = false): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type: string, data: number[]) => [...be(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  const ihdr = chunk("IHDR", [...be(width), ...be(400), 8, colorType, 0, 0, 0]);
  const trns = withTrns ? chunk("tRNS", [0, 0, 0, 0, 0, 0]) : [];
  return new Uint8Array([...sig, ...ihdr, ...trns, ...chunk("IDAT", [1, 2, 3]), ...chunk("IEND", [])]);
}

