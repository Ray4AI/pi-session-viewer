import { describe, expect, it } from "vitest";
import type { RawEntry } from "./types";
import {
  ROLE_META,
  composeQuery,
  roleMeta,
  splitSnippet,
  activeBranch,
  branchPoints,
  buildRenderItems,
  computeStats,
  formatBytes,
  formatCost,
  formatTokens,
  leaves,
} from "./sessionModel";

function session(): RawEntry[] {
  return [
    { type: "session", id: "s", timestamp: "2026-01-01T00:00:00Z" },
    {
      type: "model_change",
      id: "m1",
      parentId: null,
      provider: "anthropic",
      modelId: "claude",
    },
    {
      type: "message",
      id: "u1",
      parentId: "m1",
      timestamp: "2026-01-01T00:00:02Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:03Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "hi" },
          {
            type: "toolCall",
            id: "t1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
        usage: {
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 18,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.5,
          },
        },
      },
    },
    {
      type: "message",
      id: "r1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:04Z",
      message: {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "bash",
        content: [{ type: "text", text: "file.txt" }],
        isError: false,
      },
    },
  ];
}

describe("activeBranch", () => {
  it("walks root to latest leaf", () => {
    const branch = activeBranch(session());
    expect(branch.map((e) => e.id)).toEqual(["m1", "u1", "a1", "r1"]);
  });

  it("honors an explicit leaf id", () => {
    const entries = session();
    // Add a branch from u1.
    entries.push({
      type: "message",
      id: "a2",
      parentId: "u1",
      timestamp: "2026-01-01T00:01:00Z",
      message: { role: "assistant", content: [{ type: "text", text: "alt" }] },
    });
    const branch = activeBranch(entries, "a2");
    expect(branch.map((e) => e.id)).toEqual(["m1", "u1", "a2"]);
  });
});

describe("leaves and branchPoints", () => {
  it("finds multiple leaves and the fork point", () => {
    const entries = session();
    entries.push({
      type: "message",
      id: "a2",
      parentId: "u1",
      timestamp: "2026-01-01T00:01:00Z",
      message: { role: "assistant", content: [{ type: "text", text: "alt" }] },
    });
    const l = leaves(entries);
    expect(l.map((e) => e.id!).sort()).toEqual(["a2", "r1"]);
    const bp = branchPoints(entries);
    expect(bp.length).toBe(1);
    expect(bp[0].entry.id).toBe("u1");
    expect(bp[0].count).toBe(2);
  });
});

describe("buildRenderItems", () => {
  it("attaches tool results to their assistant tool call", () => {
    const items = buildRenderItems(activeBranch(session()));
    const assistant = items.find(
      (i) => i.kind === "message" && i.role === "assistant",
    );
    expect(assistant).toBeDefined();
    if (assistant?.kind === "message") {
      expect(assistant.toolCalls).toHaveLength(1);
      expect(assistant.toolCalls![0].call.name).toBe("bash");
      expect(assistant.toolCalls![0].result?.toolName).toBe("bash");
    }
    // The standalone toolResult should NOT appear as its own item.
    expect(
      items.filter((i) => i.kind === "message" && i.role === "toolResult"),
    ).toHaveLength(0);
  });

  it("renders model_change as an event", () => {
    const items = buildRenderItems(activeBranch(session()));
    const ev = items.find(
      (i) => i.kind === "event" && i.eventType === "model_change",
    );
    expect(ev).toBeDefined();
  });
});

describe("computeStats", () => {
  it("aggregates usage and counts", () => {
    const stats = computeStats(activeBranch(session()));
    expect(stats.userTurns).toBe(1);
    expect(stats.assistantTurns).toBe(1);
    expect(stats.toolCalls).toBe(1);
    expect(stats.thinkingBlocks).toBe(1);
    expect(stats.usage.total).toBe(18);
    expect(stats.usage.cost).toBeCloseTo(0.5);
    expect(stats.usage.hasUsage).toBe(true);
  });
});

describe("formatters", () => {
  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.00 MB");
  });
  it("formats tokens", () => {
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(2_500_000)).toBe("2.50M");
  });
  it("formats cost", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.001)).toBe("$0.00100");
    expect(formatCost(1.2345)).toBe("$1.234");
  });
});

describe("legacy linear sessions", () => {
  it("treats id-less entries as a flat sequence", () => {
    const entries: RawEntry[] = [
      { type: "session", timestamp: "2026-01-01T00:00:00Z" },
      { type: "message", message: { role: "user", content: "a" } },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "b" }] },
      },
    ];
    const branch = activeBranch(entries);
    expect(branch).toHaveLength(2);
    expect(leaves(entries)).toHaveLength(1);
  });
});

describe("splitSnippet", () => {
  it("splits into plain and highlighted segments", () => {
    // "hello world", highlight "world" at chars 6..11
    const segs = splitSnippet("hello world", [[6, 11]]);
    expect(segs.map((s) => s.text).join("")).toBe("hello world");
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(["world"]);
  });

  it("handles multiple and overlapping ranges", () => {
    const segs = splitSnippet("abcdef", [
      [0, 2],
      [1, 3],
      [4, 6],
    ]);
    // Must not duplicate text; ranges are merged by cursor advance.
    expect(segs.map((s) => s.text).join("")).toBe("abcdef");
  });

  it("handles CJK by character offsets", () => {
    const segs = splitSnippet("中文搜索测试", [[2, 4]]);
    expect(segs.map((s) => s.text).join("")).toBe("中文搜索测试");
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(["搜索"]);
  });

  it("returns a single plain segment when there are no highlights", () => {
    expect(splitSnippet("text", [])).toEqual([{ text: "text", hit: false }]);
  });

  it("ignores out-of-range highlights", () => {
    const segs = splitSnippet("ab", [[5, 9]]);
    expect(segs.map((s) => s.text).join("")).toBe("ab");
    expect(segs.some((s) => s.hit)).toBe(false);
  });
});

describe("composeQuery", () => {
  it("puts free text first and adds role filters", () => {
    expect(composeQuery("hello", ["user", "assistant"])).toBe(
      "hello role:user+assistant",
    );
  });

  it("adds exclusions", () => {
    expect(
      composeQuery("hello", ["user"], { excludeRoles: ["toolResult"] }),
    ).toBe("hello role:user -role:toolResult");
  });

  it("works with only role filters", () => {
    expect(composeQuery("", ["thinking"])).toBe("role:thinking");
  });

  it("omits roles both selected and excluded from the positive list", () => {
    const q = composeQuery("x", ["user", "thinking"], {
      excludeRoles: ["thinking"],
    });
    expect(q).toContain("role:user");
    expect(q).toContain("-role:thinking");
    expect(q).not.toContain("role:user+thinking");
  });

  it("returns empty string when nothing is set", () => {
    expect(composeQuery("", [])).toBe("");
  });
});

describe("roleMeta", () => {
  it("maps every role to a label and class", () => {
    for (const meta of ROLE_META) {
      expect(roleMeta(meta.key).label).toBeTruthy();
      expect(roleMeta(meta.key).className).toMatch(/^role-/);
    }
  });
});
