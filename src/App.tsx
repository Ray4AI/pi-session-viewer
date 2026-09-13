import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, isTauri } from "./api";
import type { ProjectGroup, SessionDetail, SessionSummary } from "./types";
import {
  activeBranch,
  branchPoints,
  buildRenderItems,
  computeStats,
  formatBytes,
  formatCost,
  formatTime,
  formatTokens,
  leaves,
  sessionTitle,
} from "./sessionModel";
import { Sidebar } from "./components/Sidebar";
import { MessageView } from "./components/MessageView";
import "./App.css";

export default function App() {
  const [root, setRoot] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projects, setProjects] = useState<ProjectGroup[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leafId, setLeafId] = useState<string | null>(null);

  const refresh = useCallback(
    async (r?: string) => {
      if (!isTauri) {
        setError("请在 Tauri 应用中运行（npm run tauri dev）");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const useRoot = r ?? root;
        const list = await api.listSessions(useRoot || undefined);
        setSessions(list);
        const groups = await api.listProjects(useRoot || undefined);
        setProjects(groups);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [root],
  );

  // Initial load.
  useEffect(() => {
    (async () => {
      if (!isTauri) {
        setError("请在 Tauri 应用中运行（npm run tauri dev）");
        return;
      }
      try {
        const r = await api.defaultSessionsRoot();
        setRoot(r);
        await refresh(r);
      } catch (e) {
        setError(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectSession = useCallback(async (path: string) => {
    setSelectedPath(path);
    try {
      const d = await api.loadSession(path);
      setDetail(d);
      setLeafId(null);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const pickRoot = useCallback(async () => {
    if (!isTauri) return;
    const picked = await open({
      directory: true,
      multiple: false,
      title: "选择会话目录",
    });
    if (typeof picked === "string") {
      setRoot(picked);
      setActiveProject(null);
      await refresh(picked);
    }
  }, [refresh]);

  const branch = useMemo(() => {
    if (!detail) return [];
    return activeBranch(detail.entries, leafId);
  }, [detail, leafId]);

  const items = useMemo(() => buildRenderItems(branch), [branch]);
  const stats = useMemo(() => computeStats(branch), [branch]);
  const branchChoices = useMemo(
    () => (detail ? leaves(detail.entries) : []),
    [detail],
  );
  const branches = useMemo(
    () => (detail ? branchPoints(detail.entries) : []),
    [detail],
  );

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        projects={projects}
        selectedPath={selectedPath}
        onSelect={selectSession}
        query={query}
        onQuery={setQuery}
        activeProject={activeProject}
        onProject={setActiveProject}
        root={root}
        onPickRoot={pickRoot}
        loading={loading}
        onRefresh={() => refresh()}
      />

      <main className="main">
        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}
        {!detail ? (
          <EmptyState hasSessions={sessions.length > 0} />
        ) : (
          <>
            <SessionHeader
              detail={detail}
              stats={stats}
              branchCount={branchChoices.length}
              branchPoints={branches.length}
              leafId={leafId}
              onLeafChange={setLeafId}
            />
            <div className="timeline">
              {items.map((item, i) =>
                item.kind === "message" ? (
                  <MessageView
                    key={item.entry.id ?? i}
                    role={item.role}
                    message={item.message}
                    toolCalls={item.toolCalls}
                    index={i}
                    timestamp={item.entry.timestamp}
                  />
                ) : (
                  <EventRow
                    key={item.entry.id ?? i}
                    label={item.label}
                    detail={item.detail}
                    timestamp={item.entry.timestamp}
                  />
                ),
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function SessionHeader({
  detail,
  stats,
  branchCount,
  branchPoints,
  leafId,
  onLeafChange,
}: {
  detail: SessionDetail;
  stats: ReturnType<typeof computeStats>;
  branchCount: number;
  branchPoints: number;
  leafId: string | null;
  onLeafChange: (id: string | null) => void;
}) {
  return (
    <header className="session-header">
      <div className="header-title-row">
        <h1>{sessionTitle(detail)}</h1>
        {detail.summary.has_errors && (
          <span className="badge-error">包含错误</span>
        )}
      </div>
      <div className="header-meta">
        <Meta label="目录" value={detail.summary.cwd} mono />
        <Meta label="会话 ID" value={detail.summary.id.slice(0, 8)} mono />
        {detail.summary.model && (
          <Meta label="模型" value={detail.summary.model} />
        )}
        {detail.summary.version != null && (
          <Meta label="格式版本" value={`v${detail.summary.version}`} />
        )}
        <Meta label="创建" value={formatTime(detail.summary.created_at)} />
        <Meta label="更新" value={formatTime(detail.summary.updated_at)} />
        <Meta label="大小" value={formatBytes(detail.summary.size_bytes)} />
      </div>
      <div className="header-stats">
        <Stat label="用户轮次" value={String(stats.userTurns)} />
        <Stat label="助手回复" value={String(stats.assistantTurns)} />
        <Stat label="工具调用" value={String(stats.toolCalls)} />
        <Stat label="思考块" value={String(stats.thinkingBlocks)} />
        {stats.usage.hasUsage && (
          <>
            <Stat label="输入 Tokens" value={formatTokens(stats.usage.input)} />
            <Stat
              label="输出 Tokens"
              value={formatTokens(stats.usage.output)}
            />
            {stats.usage.cacheRead > 0 && (
              <Stat
                label="缓存读"
                value={formatTokens(stats.usage.cacheRead)}
              />
            )}
            <Stat label="总花费" value={formatCost(stats.usage.cost)} />
          </>
        )}
      </div>
      {(branchCount > 1 || branchPoints > 0) && (
        <div className="branch-bar">
          <span className="branch-label">
            分支：共 {branchCount} 个叶节点
            {branchPoints > 0 ? `，${branchPoints} 个分叉点` : ""}
          </span>
          {branchCount > 1 && (
            <select
              className="branch-select"
              value={leafId ?? ""}
              onChange={(e) => onLeafChange(e.target.value || null)}
            >
              <option value="">最新分支（默认）</option>
              {detail
                ? leaves(detail.entries).map((l, i) => (
                    <option key={l.id} value={l.id!}>
                      分支 {i + 1} · {formatTime(l.timestamp)}
                    </option>
                  ))
                : null}
            </select>
          )}
        </div>
      )}
    </header>
  );
}

function EventRow({
  label,
  detail,
  timestamp,
}: {
  label: string;
  detail?: string;
  timestamp?: string;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!detail;
  return (
    <div className="event-row">
      <div className="event-line" />
      <div className="event-body">
        <button
          className="event-head"
          onClick={() => hasDetail && setOpen((v) => !v)}
        >
          <span className="event-dot" />
          <span className="event-label">{label}</span>
          {timestamp && (
            <span className="event-time">{formatTime(timestamp)}</span>
          )}
          {hasDetail && <span className="chev">{open ? "▾" : "▸"}</span>}
        </button>
        {open && hasDetail && (
          <pre className="code-block event-detail">
            <code>{detail}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

function Meta({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <span className={`meta-item ${mono ? "mono" : ""}`}>
      <span className="meta-label">{label}</span>
      <span className="meta-value">{value}</span>
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </span>
  );
}

function EmptyState({ hasSessions }: { hasSessions: boolean }) {
  return (
    <div className="empty-state">
      <div className="empty-mark">π</div>
      <h2>{hasSessions ? "选择一个会话" : "未找到会话"}</h2>
      <p>
        {hasSessions
          ? "从左侧列表选择一个会话，查看结构化对话记录。"
          : "请确认会话目录正确，或点击左侧「更改」选择目录。"}
      </p>
    </div>
  );
}
