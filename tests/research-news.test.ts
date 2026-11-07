import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { parsePageAge, parseSearchResponse, windowCheck } from "@/lib/research/news";

const now = new Date("2026-11-07T12:00:00Z");

describe("parsePageAge", () => {
  it("parses relative ages", () => {
    expect(parsePageAge("3 days ago", now)).toBe("2026-11-04T12:00:00.000Z");
    expect(parsePageAge("2 weeks ago", now)).toBe("2026-10-24T12:00:00.000Z");
  });
  it("parses absolute dates and rejects garbage", () => {
    expect(parsePageAge("October 31, 2026", now)?.slice(0, 10)).toBe("2026-10-31");
    expect(parsePageAge("sometime", now)).toBeNull();
    expect(parsePageAge(null, now)).toBeNull();
  });
});

describe("windowCheck", () => {
  it("classifies items by the media window and as_of", () => {
    expect(windowCheck("2026-10-01T00:00:00Z", now, 3)).toBe("in");
    expect(windowCheck("2026-06-01T00:00:00Z", now, 3)).toBe("too_old");
    expect(windowCheck("2026-11-08T00:00:00Z", now, 3)).toBe("after_as_of");
    expect(windowCheck(null, now, 3)).toBe("undated");
  });
});

describe("parseSearchResponse", () => {
  const blocks = [
    { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "DEMO" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "s1",
      content: [
        { type: "web_search_result", url: "https://www.reuters.com/a", title: "Demo raises outlook", page_age: "2 days ago", encrypted_content: "x" },
        { type: "web_search_result", url: "https://finance.yahoo.com/b", title: "Demo outlook repost", page_age: "1 day ago", encrypted_content: "x" },
      ],
    },
    { type: "text", text: "Findings:\n§ [BULLISH; FACT; demo-raises-outlook] Demo raised its full-year outlook.", citations: [
      { type: "web_search_result_location", url: "https://www.reuters.com/a", title: "Demo raises outlook", cited_text: "raised", encrypted_index: "i" },
      { type: "web_search_result_location", url: "https://finance.yahoo.com/b", title: "repost", cited_text: "raised", encrypted_index: "i" },
    ] },
    { type: "text", text: "\n§ [BEARISH; SPECULATION; takeover-rumor] Unverified chatter about a takeover.", citations: [
      { type: "web_search_result_location", url: "https://not-retrieved.example/c", title: "x", cited_text: "x", encrypted_index: "i" },
    ] },
    { type: "text", text: "\n§ [NEUTRAL; OPINION; no-cite] An uncited opinion." },
  ] as unknown as Anthropic.Beta.BetaContentBlock[];

  const { findings, results } = parseSearchResponse(blocks);

  it("indexes retrieved pages with their page age", () => {
    expect(results.get("https://www.reuters.com/a")?.page_age).toBe("2 days ago");
  });
  it("keeps findings cited to retrieved pages and parses tags", () => {
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ direction: "BULLISH", verification: "confirmed_fact", event_key: "demo-raises-outlook" });
    expect(findings[0].urls).toHaveLength(2); // two outlets, one event key → one independent event downstream
  });
  it("drops findings whose citations were not actually retrieved, or have none", () => {
    expect(findings.find((f) => f.event_key === "takeover-rumor")).toBeUndefined();
    expect(findings.find((f) => f.event_key === "no-cite")).toBeUndefined();
  });
});
