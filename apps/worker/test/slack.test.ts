import { describe, expect, it } from "vitest";
import { buildSlackMessage, formatMoney, sendSlackAlert, slackEscape } from "../src/services/slack";
import type { Env } from "../src/env";

const env = (over: Partial<Env> = {}) => ({ SLACK_WEBHOOK_REVENUE: "https://hooks.slack.com/services/x", ...over }) as Env;

describe("Slack helper", () => {
  it("escapes what clients type, so they can't ping @channel or add links", () => {
    expect(slackEscape("<!channel> & <https://evil.test|click>")).toBe("&lt;!channel&gt; &amp; &lt;https://evil.test|click&gt;");
    const msg = buildSlackMessage({ channel: "REVENUE", title: "Hi", fields: [{ label: "Client", value: "<!here>" }] });
    expect(JSON.stringify(msg)).not.toContain("<!here>");
  });

  it("keeps only https buttons and stays inside Slack's limits", () => {
    const msg: any = buildSlackMessage({
      channel: "SPRINT_OPS",
      title: "x".repeat(400),
      fields: Array.from({ length: 15 }, (_, i) => ({ label: `L${i}`, value: "v" })),
      links: [
        { label: "Bad", url: "javascript:alert(1)" },
        { label: "Plain http", url: "http://example.com" },
        { label: "Good", url: "https://example.com/epic" },
      ],
    });
    expect(msg.blocks[0].text.text.length).toBeLessThanOrEqual(150);
    expect(msg.blocks[1].fields).toHaveLength(10);
    const buttons = msg.blocks.find((b: any) => b.type === "actions").elements;
    expect(buttons.map((b: any) => b.url)).toEqual(["https://example.com/epic"]);
  });

  it("skips without calling out when the channel's webhook isn't set", async () => {
    let called = false;
    const r = await sendSlackAlert(env(), { channel: "ERRORS", title: "x" }, (async () => {
      called = true;
      return new Response("ok");
    }) as unknown as typeof fetch);
    expect(r).toEqual({ sent: false, reason: "not_configured" });
    expect(called).toBe(false);
  });

  it("never throws: a bad answer or a network failure comes back as a result", async () => {
    const bad = await sendSlackAlert(env(), { channel: "REVENUE", title: "x" }, (async () =>
      new Response("invalid_token", { status: 403 })) as unknown as typeof fetch);
    expect(bad).toEqual({ sent: false, reason: "http_error", status: 403 });

    const down = await sendSlackAlert(env(), { channel: "REVENUE", title: "x" }, (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);
    expect(down).toEqual({ sent: false, reason: "network_error" });
  });

  it("formats Stripe amounts from the smallest unit", () => {
    expect(formatMoney(150000, "usd")).toBe("$1,500.00");
    expect(formatMoney(275000, "USD")).toBe("$2,750.00");
    expect(formatMoney(5000, "jpy")).toBe("¥5,000");
    expect(formatMoney(null, "usd")).toBe("unknown amount");
  });
});
