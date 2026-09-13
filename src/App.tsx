import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, isTauri } from "./api";
import type {
  ProjectGroup,
  SearchHit,
  SessionDetail,
  SessionSummary,
} from "./types";
import {
  activeBranch,
  branchPoints,
  buildRenderItems,
  computeStats,
  formatBytes,
  formatCost,
  formatTime,
  findItemMatches,
  findLeafContaining,
  formatTokens,
  leaves,
  sessionTitle,
} from "./sessionModel";
import { Sidebar } from "./components/Sidebar";
import { MessageView } from "./components/MessageView";
import { SearchPanel } from "./components/SearchPanel";
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
  /** "sessions" = browse sidebar, "search" = full-text search view. */
  const [view, setView] = useState<"sessions" | "search">("sessions");
  /** Entry id to scroll to + flash after jumping from a search hit. */
  const [focusEntry, setFocusEntry] = useState<string | null>(null);
  /** Bumped to re-run the search after a refresh. */
  const [searchToken, setSearchToken] = useState(0);
  /** In-session find (independent of global content search). */
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [findIndex, setFindIndex] = useState(0);

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
        setSearchToken((n) => n + 1);
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

  const selectSession = useCallback(
    async (path: string, focus?: string | null) => {
      setSelectedPath(path);
      setFocusEntry(focus ?? null);
      try {
        const d = await api.loadSession(path);
        setDetail(d);
        // A search hit may live on a non-default branch; pick the leaf that
        // contains it so the message is actually rendered.
        setLeafId(focus ? findLeafContaining(d, focus) : null);
        if (!focus) window.scrollTo({ top: 0 });
      } catch (e) {
        setError(String(e));
      }
    },
    [],
  );

  // Scroll to (and briefly highlight) a message after jumping from search.
  useEffect(() => {
    if (!focusEntry || !detail) return;
    const t = setTimeout(() => {
      const el = document.getElementById(`entry-${focusEntry}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 1600);
      } else {
        // Not on this branch — fall back to the top so the view isn't blank.
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    }, 120);
    return () => clearTimeout(t);
  }, [focusEntry, detail, leafId]);

  const openSearchHit = useCallback(
    async (hit: SearchHit) => {
      if (hit.sessionPath === selectedPath && detail) {
        // Same session: make sure the hit's branch is the one on screen,
        // otherwise the target element would not exist.
        setLeafId(findLeafContaining(detail, hit.entryId));
        setFocusEntry(null);
        // Re-set on the next frame so the effect re-runs even for a repeat hit.
        requestAnimationFrame(() => setFocusEntry(hit.entryId));
      } else {
        await selectSession(hit.sessionPath, hit.entryId);
      }
      setView("sessions");
    },
    [selectedPath, detail, selectSession],
  );

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

  // In-session find: which rendered items contain the text.
  const findMatches = useMemo(
    () => (findOpen && findText.trim() ? findItemMatches(items, findText) : []),
    [items, findText, findOpen],
  );

  // Keep the active match index in range as the query changes.
  useEffect(() => {
    setFindIndex(0);
  }, [findText, detail]);

  // Scroll to the active in-session match.
  useEffect(() => {
    if (!findOpen || findMatches.length === 0) return;
    const itemIdx = findMatches[Math.min(findIndex, findMatches.length - 1)];
    const entryId = items[itemIdx]?.entry.id;
    if (!entryId) return;
    const el = document.getElementById(`entry-${entryId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("find-active");
      const t = setTimeout(() => el.classList.remove("find-active"), 1200);
      return () => clearTimeout(t);
    }
  }, [findIndex, findMatches, findOpen, items]);

  const gotoMatch = useCallback(
    (delta: number) => {
      if (findMatches.length === 0) return;
      setFindIndex((i) => {
        const n = findMatches.length;
        return (((i + delta) % n) + n) % n;
      });
    },
    [findMatches.length],
  );

  // Ctrl/Cmd+F opens the in-session find bar when a session is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        if (!detail) return;
        e.preventDefault();
        setFindOpen(true);
        setTimeout(() => {
          const el = document.getElementById(
            "find-input",
          ) as HTMLInputElement | null;
          el?.focus();
          el?.select();
        }, 0);
      }
      if (e.key === "Escape" && findOpen) {
        setFindOpen(false);
        setFindText("");
      }
      if (
        e.key === "F3" ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g")
      ) {
        if (!findOpen) return;
        e.preventDefault();
        gotoMatch(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, findOpen, gotoMatch]);

  // Reset find when switching sessions.
  useEffect(() => {
    setFindOpen(false);
    setFindText("");
    setFindIndex(0);
  }, [selectedPath]);

  return (
    <div className={`app ${view === "search" ? "search-mode" : ""}`}>
      <div className="left-pane">
        <div className="view-switch">
          <button
            className={view === "sessions" ? "on" : ""}
            onClick={() => setView("sessions")}
          >
            📂 会话
          </button>
          <button
            className={view === "search" ? "on" : ""}
            onClick={() => setView("search")}
            title="全文内容搜索 (Ctrl+K)"
          >
            🔍 搜索
          </button>
        </div>
        {view === "search" ? (
          <SearchPanel
            root={root}
            refreshToken={searchToken}
            onOpenHit={openSearchHit}
          />
        ) : (
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
        )}
      </div>

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
              onFind={() => {
                setFindOpen(true);
                setTimeout(() => {
                  const el = document.getElementById(
                    "find-input",
                  ) as HTMLInputElement | null;
                  el?.focus();
                }, 0);
              }}
            />
            {findOpen && (
              <div className="find-bar">
                <span className="find-icon">🔎</span>
                <input
                  id="find-input"
                  className="find-input"
                  value={findText}
                  onChange={(e) => setFindText(e.target.value)}
                  placeholder="在本会话中查找…  (Enter 下一个 / Esc 关闭)"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      gotoMatch(e.shiftKey ? -1 : 1);
                    }
                  }}
                />
                <span className="find-count">
                  {findText.trim()
                    ? findMatches.length > 0
                      ? `${Math.min(findIndex + 1, findMatches.length)} / ${findMatches.length}`
                      : "无匹配"
                    : ""}
                </span>
                <button
                  className="find-btn"
                  onClick={() => gotoMatch(-1)}
                  disabled={findMatches.length === 0}
                  title="上一个 (Shift+Enter)"
                >
                  ↑
                </button>
                <button
                  className="find-btn"
                  onClick={() => gotoMatch(1)}
                  disabled={findMatches.length === 0}
                  title="下一个 (Enter)"
                >
                  ↓
                </button>
                <button
                  className="find-btn"
                  onClick={() => {
                    setFindOpen(false);
                    setFindText("");
                  }}
                  title="关闭 (Esc)"
                >
                  ×
                </button>
              </div>
            )}
            <div className="timeline">
              {items.map((item, i) => (
                <div
                  key={item.entry.id ?? i}
                  id={item.entry.id ? `entry-${item.entry.id}` : undefined}
                  className="entry-anchor"
                >
                  {item.kind === "message" ? (
                    <MessageView
                      role={item.role}
                      message={item.message}
                      toolCalls={item.toolCalls}
                      index={i}
                      timestamp={item.entry.timestamp}
                      highlight={
                        findOpen && findText.trim() ? findText : undefined
                      }
                    />
                  ) : (
                    <EventRow
                      label={item.label}
                      detail={item.detail}
                      timestamp={item.entry.timestamp}
                    />
                  )}
                </div>
              ))}
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
  onFind,
}: {
  detail: SessionDetail;
  stats: ReturnType<typeof computeStats>;
  branchCount: number;
  branchPoints: number;
  leafId: string | null;
  onLeafChange: (id: string | null) => void;
  onFind: () => void;
}) {
  return (
    <header className="session-header">
      <div className="header-title-row">
        <h1>{sessionTitle(detail)}</h1>
        {detail.summary.has_errors && (
          <span className="badge-error">包含错误</span>
        )}
        <button
          className="header-find-btn"
          onClick={onFind}
          title="在本会话中查找 (Ctrl+F)"
        >
          🔎 查找
        </button>
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
