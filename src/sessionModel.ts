// Build the active branch and turn it into a structured, render-ready model.

import type {
  AgentMessage,
  ContentBlock,
  RawEntry,
  SessionDetail,
  TokenTotals,
  ToolCall,
  Usage,
} from "./types";

export interface ToolCallView {
  call: ToolCall;
  result?: AgentMessage;
}

export type RenderItem =
  | {
      kind: "message";
      role: "user" | "assistant" | "toolResult" | "custom";
      entry: RawEntry;
      message: AgentMessage;
      toolCalls?: ToolCallView[];
    }
  | {
      kind: "event";
      entry: RawEntry;
      eventType: string;
      label: string;
      detail?: string;
    };

export interface SessionStats {
  usage: TokenTotals;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  thinkingBlocks: number;
}

/** Build the child lookup used for branch navigation. */
export function buildTree(entries: RawEntry[]): Map<string | null, RawEntry[]> {
  const children = new Map<string | null, RawEntry[]>();
  for (const e of entries) {
    if (e.type === "session") continue; // header is not part of the tree
    const parent = (e.parentId ?? null) as string | null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(e);
  }
  return children;
}

/** Walk root → leaf along the latest child at each node. */
export function activeBranch(
  entries: RawEntry[],
  leafId?: string | null,
): RawEntry[] {
  const treeEntries = entries.filter((e) => e.type !== "session");
  if (treeEntries.length === 0) return [];

  // Legacy v1 sessions are a linear sequence with no id/parentId linking.
  const hasAnyId = treeEntries.some((e) => e.id);
  const rootCount = treeEntries.filter((e) => !e.parentId).length;
  if (!hasAnyId || rootCount === treeEntries.length) return treeEntries;

  const children = buildTree(treeEntries);
  const byId = new Map<string, RawEntry>();
  for (const e of treeEntries) if (e.id) byId.set(e.id, e);

  // If a specific leaf was requested, walk up from it to the root.
  if (leafId && byId.has(leafId)) {
    const path: RawEntry[] = [];
    let cur: RawEntry | undefined = byId.get(leafId);
    const guard = new Set<string>();
    while (cur && cur.id && !guard.has(cur.id)) {
      guard.add(cur.id);
      path.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return path;
  }

  const root = treeEntries.find((e) => !e.parentId) ?? treeEntries[0];
  const path: RawEntry[] = [];
  let current: RawEntry | undefined = root;
  const guard = new Set<string>();
  while (current) {
    path.push(current);
    if (current.id) {
      if (guard.has(current.id)) break;
      guard.add(current.id);
    }
    const kids: RawEntry[] = children.get(current.id ?? null) ?? [];
    current = kids.length > 0 ? kids[kids.length - 1] : undefined;
  }
  return path;
}

/** All leaf entries (nodes without children). */
export function leaves(entries: RawEntry[]): RawEntry[] {
  const treeEntries = entries.filter((e) => e.type !== "session");
  const hasAnyId = treeEntries.some((e) => e.id);
  if (!hasAnyId) return treeEntries.slice(-1);
  const children = buildTree(treeEntries);
  const hasChild = new Set<string>();
  for (const [parent, kids] of children) {
    if (parent && kids.length > 0) hasChild.add(parent);
  }
  const leaves = treeEntries.filter((e) => e.id && !hasChild.has(e.id));
  return leaves.length > 0 ? leaves : treeEntries.slice(-1);
}

/** Nodes that have more than one child (branch points). */
export function branchPoints(
  entries: RawEntry[],
): { entry: RawEntry; count: number }[] {
  const treeEntries = entries.filter((e) => e.type !== "session");
  const children = buildTree(treeEntries);
  const byId = new Map<string, RawEntry>();
  for (const e of treeEntries) if (e.id) byId.set(e.id, e);
  const points: { entry: RawEntry; count: number }[] = [];
  for (const [parent, kids] of children) {
    if (parent && kids.length > 1) {
      const p = byId.get(parent);
      if (p) points.push({ entry: p, count: kids.length });
    }
  }
  return points;
}

export function messageOf(entry: RawEntry): AgentMessage | undefined {
  const m = entry["message"];
  if (m && typeof m === "object") return m as AgentMessage;
  return undefined;
}

export function contentBlocks(
  content: string | ContentBlock[] | undefined,
): ContentBlock[] {
  if (!content) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

export function isToolCall(block: ContentBlock): block is ToolCall {
  return block.type === "toolCall";
}

/** Turn the active branch into ordered render items with tool results attached. */
export function buildRenderItems(branch: RawEntry[]): RenderItem[] {
  // Index tool results by their toolCallId for attachment.
  const resultsByCallId = new Map<string, AgentMessage>();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const msg = messageOf(entry);
    if (msg?.role === "toolResult" && msg.toolCallId) {
      resultsByCallId.set(msg.toolCallId, msg);
    }
  }

  const items: RenderItem[] = [];

  for (const entry of branch) {
    switch (entry.type) {
      case "message": {
        const msg = messageOf(entry);
        if (!msg) break;
        if (msg.role === "toolResult") {
          if (msg.toolCallId && resultsByCallId.has(msg.toolCallId)) {
            // Attached to its assistant tool call; skip standalone rendering.
            break;
          }
          items.push({
            kind: "message",
            role: "toolResult",
            entry,
            message: msg,
          });
          break;
        }
        if (msg.role === "user") {
          items.push({ kind: "message", role: "user", entry, message: msg });
          break;
        }
        if (msg.role === "assistant") {
          const blocks = contentBlocks(msg.content);
          const toolCalls: ToolCallView[] = blocks
            .filter(isToolCall)
            .map((call) => ({
              call,
              result: call.id ? resultsByCallId.get(call.id) : undefined,
            }));
          items.push({
            kind: "message",
            role: "assistant",
            entry,
            message: msg,
            toolCalls,
          });
          break;
        }
        if (msg.role === "custom" || msg.role === "bashExecution") {
          items.push({ kind: "message", role: "custom", entry, message: msg });
          break;
        }
        // branchSummary / compactionSummary etc. rendered as events.
        items.push({
          kind: "event",
          entry,
          eventType: msg.role,
          label: humanRole(msg.role),
          detail:
            typeof (msg as { summary?: unknown }).summary === "string"
              ? String((msg as { summary?: unknown }).summary)
              : undefined,
        });
        break;
      }
      case "compaction":
        items.push({
          kind: "event",
          entry,
          eventType: "compaction",
          label: "上下文压缩",
          detail: str(entry["summary"]),
        });
        break;
      case "branch_summary":
        items.push({
          kind: "event",
          entry,
          eventType: "branch_summary",
          label: "分支摘要",
          detail: str(entry["summary"]),
        });
        break;
      case "model_change":
        items.push({
          kind: "event",
          entry,
          eventType: "model_change",
          label: "切换模型",
          detail: `${str(entry["provider"])}/${str(entry["modelId"])}`,
        });
        break;
      case "thinking_level_change":
        items.push({
          kind: "event",
          entry,
          eventType: "thinking_level_change",
          label: "思考等级",
          detail: str(entry["thinkingLevel"]),
        });
        break;
      case "session_info":
        items.push({
          kind: "event",
          entry,
          eventType: "session_info",
          label: "重命名会话",
          detail: str(entry["name"]),
        });
        break;
      case "label":
        items.push({
          kind: "event",
          entry,
          eventType: "label",
          label: "标记",
          detail: str(entry["label"]),
        });
        break;
      case "custom":
        items.push({
          kind: "event",
          entry,
          eventType: "custom",
          label: `扩展状态 · ${str(entry["customType"]) || "unknown"}`,
          detail: safeJson(entry["data"]),
        });
        break;
      case "custom_message": {
        const display = entry["display"] !== false;
        if (!display) break;
        items.push({
          kind: "event",
          entry,
          eventType: "custom_message",
          label: `扩展消息 · ${str(entry["customType"]) || "unknown"}`,
          detail: contentToText(entry["content"]),
        });
        break;
      }
      default:
        items.push({
          kind: "event",
          entry,
          eventType: entry.type,
          label: entry.type,
          detail: safeJson(entry),
        });
    }
  }

  return items;
}

export function computeStats(entries: RawEntry[]): SessionStats {
  const usage: TokenTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    hasUsage: false,
  };
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let thinkingBlocks = 0;

  const addUsage = (u: Usage | undefined) => {
    if (!u) return;
    usage.hasUsage = true;
    usage.input += u.input ?? 0;
    usage.output += u.output ?? 0;
    usage.cacheRead += u.cacheRead ?? 0;
    usage.cacheWrite += u.cacheWrite ?? 0;
    usage.total += u.totalTokens ?? 0;
    if (u.cost?.total) usage.cost += u.cost.total;
  };

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = messageOf(entry);
    if (!msg) continue;
    if (msg.role === "user") userTurns++;
    if (msg.role === "assistant") {
      assistantTurns++;
      addUsage(msg.usage);
      for (const b of contentBlocks(msg.content)) {
        if (b.type === "toolCall") toolCalls++;
        if (b.type === "thinking") thinkingBlocks++;
      }
    }
    if (msg.role === "toolResult") addUsage(msg.usage);
  }
  return { usage, userTurns, assistantTurns, toolCalls, thinkingBlocks };
}

export function sessionTitle(detail: SessionDetail): string {
  return (
    detail.summary.name ||
    detail.summary.first_user_message ||
    `会话 ${detail.summary.id.slice(0, 8)}`
  );
}

// --- helpers ---

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return String(v);
}

export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function contentToText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((b) =>
        b && typeof b === "object" && "text" in b
          ? String((b as { text: unknown }).text)
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return safeJson(v);
}

function humanRole(role: string): string {
  switch (role) {
    case "branchSummary":
      return "分支摘要";
    case "compactionSummary":
      return "压缩摘要";
    case "bashExecution":
      return "Shell 执行";
    default:
      return role;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(n: number): string {
  if (!n) return "$0";
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(3)}`;
}

export function formatTime(iso: string | number | undefined | null): string {
  if (!iso) return "";
  const d = typeof iso === "number" ? new Date(iso) : new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelative(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return d.toLocaleDateString();
}
