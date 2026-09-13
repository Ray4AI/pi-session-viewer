import React, { useState } from "react";
import type { AgentMessage } from "../types";
import type { ToolCallView as ToolCallViewType } from "../sessionModel";
import {
  contentBlocks,
  formatCost,
  formatTokens,
  formatTime,
} from "../sessionModel";
import { Markdown } from "./Markdown";
import { ToolCallView } from "./ToolCallView";

interface Props {
  role: "user" | "assistant" | "toolResult" | "custom";
  message: AgentMessage;
  toolCalls?: ToolCallViewType[];
  index: number;
  timestamp?: string | number;
  /** When set, occurrences inside rendered text are highlighted. */
  highlight?: string;
}

/** Wrap every case-insensitive occurrence of `query` in a <mark>. */
export function Highlighted({ text, query }: { text: string; query?: string }) {
  if (!query || !query.trim()) return <>{text}</>;
  const q = query.trim().toLowerCase();
  const hay = text.toLowerCase();
  const out: React.ReactNode[] = [];
  let from = 0;
  let key = 0;
  for (;;) {
    const at = hay.indexOf(q, from);
    if (at === -1) break;
    if (at > from) out.push(<span key={key++}>{text.slice(from, at)}</span>);
    out.push(<mark key={key++}>{text.slice(at, at + q.length)}</mark>);
    from = at + q.length;
  }
  if (from < text.length) out.push(<span key={key++}>{text.slice(from)}</span>);
  return <>{out}</>;
}

export function MessageView({
  role,
  message,
  toolCalls,
  index,
  timestamp,
}: Props) {
  if (role === "user") return <UserMessage message={message} index={index} />;
  if (role === "assistant")
    return (
      <AssistantMessage
        message={message}
        toolCalls={toolCalls ?? []}
        timestamp={timestamp}
      />
    );
  if (role === "custom") return <CustomMessage message={message} />;
  return <ToolResultMessage message={message} />;
}

function UserMessage({
  message,
  index,
  highlight,
}: {
  message: AgentMessage;
  index: number;
  highlight?: string;
}) {
  const blocks = contentBlocks(message.content);
  return (
    <div className="msg msg-user">
      <div className="msg-avatar user">你</div>
      <div className="msg-content">
        <div className="msg-head">
          <span className="msg-role">用户</span>
          <span className="msg-time">{formatTime(message.timestamp)}</span>
          <span className="msg-index">#{index}</span>
        </div>
        {blocks.map((b, i) => {
          if (b.type === "text")
            return (
              <div key={i} className="user-text">
                <Highlighted
                  text={String((b as { text: string }).text)}
                  query={highlight}
                />
              </div>
            );
          if (b.type === "image") {
            const img = b as unknown as { data: string; mimeType: string };
            return (
              <img
                key={i}
                className="msg-image"
                src={`data:${img.mimeType};base64,${img.data}`}
                alt="附件"
              />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  toolCalls,
  timestamp,
  highlight,
}: {
  message: AgentMessage;
  toolCalls: ToolCallViewType[];
  timestamp?: string | number;
  highlight?: string;
}) {
  const blocks = contentBlocks(message.content);
  const usage = message.usage;

  return (
    <div className="msg msg-assistant">
      <div className="msg-avatar assistant">π</div>
      <div className="msg-content">
        <div className="msg-head">
          <span className="msg-role">助手</span>
          {message.model && <span className="msg-model">{message.model}</span>}
          <span className="msg-time">
            {formatTime(timestamp ?? message.timestamp)}
          </span>
          {message.stopReason === "error" && (
            <span className="badge-error">错误</span>
          )}
        </div>

        {message.errorMessage && (
          <div className="error-message">
            <span className="error-message-label">请求失败</span>
            <span className="error-message-text">{message.errorMessage}</span>
          </div>
        )}

        {blocks.map((b, i) => {
          if (b.type === "thinking") {
            return (
              <ThinkingBlock
                key={i}
                text={String((b as { thinking: string }).thinking)}
                query={highlight}
              />
            );
          }
          if (b.type === "text") {
            const t = String((b as { text: string }).text);
            // While finding, render plain text so <mark> highlights show up.
            if (highlight) {
              return (
                <div key={i} className="markdown-body find-text">
                  <Highlighted text={t} query={highlight} />
                </div>
              );
            }
            return <Markdown key={i}>{t}</Markdown>;
          }
          if (b.type === "toolCall") {
            const tc = toolCalls.find(
              (t) => t.call.id === (b as { id: string }).id,
            );
            if (tc)
              return <ToolCallView key={i} call={tc.call} result={tc.result} />;
            // fallback if not matched
            const call = b as unknown as {
              id: string;
              name: string;
              arguments: Record<string, unknown>;
            };
            return (
              <ToolCallView
                key={i}
                call={{
                  type: "toolCall",
                  id: call.id,
                  name: call.name,
                  arguments: call.arguments ?? {},
                }}
              />
            );
          }
          return null;
        })}

        {/* tool calls whose ids somehow didn't appear in blocks */}
        {toolCalls
          .filter(
            (t) =>
              !blocks.some(
                (b) =>
                  b.type === "toolCall" &&
                  (b as { id: string }).id === t.call.id,
              ),
          )
          .map((t, i) => (
            <ToolCallView key={`extra-${i}`} call={t.call} result={t.result} />
          ))}

        {usage && (
          <div className="usage-bar">
            <Usage label="输入" value={formatTokens(usage.input)} />
            <Usage label="输出" value={formatTokens(usage.output)} />
            {usage.cacheRead > 0 && (
              <Usage label="缓存读" value={formatTokens(usage.cacheRead)} />
            )}
            {usage.cacheWrite > 0 && (
              <Usage label="缓存写" value={formatTokens(usage.cacheWrite)} />
            )}
            <Usage label="总计" value={formatTokens(usage.totalTokens)} />
            {usage.cost?.total ? (
              <Usage label="花费" value={formatCost(usage.cost.total)} />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingBlock({ text, query }: { text: string; query?: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ").slice(0, 80);
  return (
    <div className="thinking">
      <button className="thinking-head" onClick={() => setOpen((v) => !v)}>
        <span className="thinking-icon">💭</span>
        <span className="thinking-label">思考过程</span>
        {!open && <span className="thinking-preview">{preview}…</span>}
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <pre className="thinking-body">
          {query ? <Highlighted text={text} query={query} /> : text}
        </pre>
      )}
    </div>
  );
}

function CustomMessage({ message }: { message: AgentMessage }) {
  const blocks = contentBlocks(message.content);
  const text = blocks
    .map((b) => (b.type === "text" ? String((b as { text: string }).text) : ""))
    .filter(Boolean)
    .join("\n");
  return (
    <div className="msg msg-custom">
      <div className="msg-avatar custom">⚙</div>
      <div className="msg-content">
        <div className="msg-head">
          <span className="msg-role">
            扩展消息 · {message.customType || "unknown"}
          </span>
        </div>
        <pre className="code-block">{text}</pre>
      </div>
    </div>
  );
}

function ToolResultMessage({ message }: { message: AgentMessage }) {
  const blocks = contentBlocks(message.content);
  const text = blocks
    .map((b) => (b.type === "text" ? String((b as { text: string }).text) : ""))
    .filter(Boolean)
    .join("\n");
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`msg msg-toolresult ${message.isError ? "tool-error" : ""}`}
    >
      <div className="msg-avatar tool">🔧</div>
      <div className="msg-content">
        <button
          className="msg-head clickable"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="msg-role">工具结果</span>
          <span className="msg-model">{message.toolName}</span>
          {message.isError && <span className="badge-error">错误</span>}
          <span className="chev">{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <pre className="code-block output">
            <code>{text.slice(0, 30000)}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

function Usage({ label, value }: { label: string; value: string }) {
  return (
    <span className="usage-item">
      <span className="usage-label">{label}</span>
      <span className="usage-value">{value}</span>
    </span>
  );
}
