import { useState } from "react";
import type { AgentMessage, ToolCall } from "../types";
import { contentBlocks } from "../sessionModel";
import { Markdown } from "./Markdown";

interface Props {
  call: ToolCall;
  result?: AgentMessage;
}

/** Pretty-print a tool call + result with tool-specific rendering. */
export function ToolCallView({ call, result }: Props) {
  const [open, setOpen] = useState(false);
  const args = call.arguments ?? {};
  const resultText = resultTextOf(result);
  const isError = result?.isError === true;
  const command = typeof args.command === "string" ? args.command : undefined;
  const filePath = typeof args.path === "string" ? args.path : undefined;

  const summary = buildSummary(args, result);

  return (
    <div className={`tool-call ${isError ? "tool-error" : ""}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-chev">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{call.name}</span>
        <span className="tool-summary">{summary}</span>
        {isError && <span className="tool-err-badge">错误</span>}
        {result?.usage?.totalTokens ? (
          <span className="tool-tokens">{result.usage.totalTokens} tok</span>
        ) : null}
      </button>

      {open && (
        <div className="tool-body">
          {command && (
            <div className="tool-section">
              <div className="tool-label">命令</div>
              <pre className="code-block shell">
                <code>$ {command}</code>
              </pre>
            </div>
          )}

          {filePath && (
            <div className="tool-section">
              <div className="tool-label">文件</div>
              <code className="file-path">{filePath}</code>
            </div>
          )}

          <ArgsView name={call.name} args={args} hide={["command", "path"]} />

          {resultText && (
            <div className="tool-section">
              <div className="tool-label">输出</div>
              {call.name === "edit" && looksLikeDiff(resultText) ? (
                <DiffView text={resultText} />
              ) : (
                <OutputView name={call.name} text={resultText} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ArgsView({
  name,
  args,
  hide,
}: {
  name: string;
  args: Record<string, unknown>;
  hide: string[];
}) {
  const keys = Object.keys(args).filter((k) => !hide.includes(k));
  if (keys.length === 0) return null;

  // edit uses `edits: [{oldText,newText}]` — render as a diff-ish list.
  if (name === "edit" && Array.isArray(args.edits)) {
    return (
      <div className="tool-section">
        <div className="tool-label">编辑内容（{args.edits.length} 处）</div>
        {(args.edits as Array<{ oldText?: string; newText?: string }>).map(
          (ed, i) => (
            <div key={i} className="edit-block">
              <pre className="code-block removed">
                <code>{ed.oldText ?? ""}</code>
              </pre>
              <pre className="code-block added">
                <code>{ed.newText ?? ""}</code>
              </pre>
            </div>
          ),
        )}
      </div>
    );
  }

  return (
    <div className="tool-section">
      <div className="tool-label">参数</div>
      <pre className="code-block json">
        <code>{JSON.stringify(pick(args, keys), null, 2)}</code>
      </pre>
    </div>
  );
}

function OutputView({ name, text }: { name: string; text: string }) {
  // Markdown-ish outputs and web fetches render as markdown.
  const mdTools = [
    "aio-webfetch",
    "aio-websearch",
    "web_fetch_exa",
    "web_search_exa",
    "aio-webcontent",
    "aio-webquery",
    "aio-webresearch",
  ];
  if (mdTools.includes(name) && text.length > 0) {
    return <Markdown>{text.slice(0, 20000)}</Markdown>;
  }
  return (
    <pre className="code-block output">
      <code>{truncateOutput(text)}</code>
    </pre>
  );
}

function DiffView({ text }: { text: string }) {
  return (
    <pre className="code-block diff">
      <code>
        {text.split("\n").map((line, i) => {
          let cls = "";
          if (line.startsWith("+") && !line.startsWith("+++")) cls = "diff-add";
          else if (line.startsWith("-") && !line.startsWith("---"))
            cls = "diff-del";
          else if (line.startsWith("@@")) cls = "diff-hunk";
          return (
            <span key={i} className={cls}>
              {line}
              {"\n"}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function buildSummary(
  args: Record<string, unknown>,
  result?: AgentMessage,
): string {
  if (typeof args.command === "string")
    return truncate(args.command.replace(/\s+/g, " "), 90);
  if (typeof args.path === "string") {
    const extra: string[] = [];
    if (args.offset !== undefined) extra.push(`offset=${args.offset}`);
    if (args.limit !== undefined) extra.push(`limit=${args.limit}`);
    if (typeof args.pattern === "string")
      extra.push(`pattern=${truncate(args.pattern, 40)}`);
    return `${args.path}${extra.length ? " · " + extra.join(" ") : ""}`;
  }
  if (typeof args.url === "string") return truncate(args.url, 100);
  if (Array.isArray(args.urls)) return `${args.urls.length} 个 URL`;
  if (typeof args.query === "string") return truncate(args.query, 100);
  if (typeof args.pattern === "string") return truncate(args.pattern, 80);
  if (typeof args.kind === "string") return `kind=${args.kind}`;
  if (typeof args.name === "string") return truncate(args.name, 80);
  const err = result?.isError ? "（失败）" : "";
  const keys = Object.keys(args);
  if (keys.length === 0) return err;
  return truncate(JSON.stringify(args), 80) + err;
}

function resultTextOf(result?: AgentMessage): string {
  if (!result) return "";
  const blocks = contentBlocks(result.content);
  return blocks
    .map((b) => (b.type === "text" ? String((b as { text: string }).text) : ""))
    .filter(Boolean)
    .join("\n");
}

function looksLikeDiff(s: string): boolean {
  return /^@@/m.test(s) || /^(---|\+\+\+) /m.test(s);
}

function truncateOutput(s: string): string {
  const MAX = 30000;
  if (s.length <= MAX) return s;
  return s.slice(0, MAX) + `\n\n… 输出已截断（共 ${s.length} 字符）`;
}

function pick(obj: Record<string, unknown>, keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
