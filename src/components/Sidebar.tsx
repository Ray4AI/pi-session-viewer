import { useMemo, useState } from "react";
import type { SessionSummary } from "../types";
import { formatBytes, formatRelative } from "../sessionModel";

interface Props {
  sessions: SessionSummary[];
  projects: { key: string; label: string; session_count: number }[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  query: string;
  onQuery: (q: string) => void;
  activeProject: string | null;
  onProject: (key: string | null) => void;
  root: string;
  onPickRoot: () => void;
  loading: boolean;
  onRefresh: () => void;
}

export function Sidebar({
  sessions,
  projects,
  selectedPath,
  onSelect,
  query,
  onQuery,
  activeProject,
  onProject,
  root,
  onPickRoot,
  loading,
  onRefresh,
}: Props) {
  const [showProjects, setShowProjects] = useState(true);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (activeProject && s.project_key !== activeProject) return false;
      if (!q) return true;
      const hay = [s.name, s.cwd, s.model, s.id, s.first_user_message]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [sessions, query, activeProject]);

  const grouped = useMemo(() => {
    const map = new Map<string, SessionSummary[]>();
    for (const s of filtered) {
      if (!map.has(s.project_key)) map.set(s.project_key, []);
      map.get(s.project_key)!.push(s);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark">π</span>
          <div>
            <div className="brand-title">Pi Session Viewer</div>
            <div className="brand-sub">会话记录可视化</div>
          </div>
        </div>
        <div className="sidebar-actions">
          <button className="icon-btn" onClick={onRefresh} title="刷新">
            {loading ? "…" : "⟳"}
          </button>
        </div>
      </div>

      <div className="root-bar" title={root}>
        <span className="root-path">{root || "（未设置）"}</span>
        <button className="mini-btn" onClick={onPickRoot}>
          更改
        </button>
      </div>

      <div className="search-box">
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="搜索会话 / 目录 / 模型…"
        />
        {query && (
          <button className="clear-btn" onClick={() => onQuery("")}>
            ×
          </button>
        )}
      </div>

      <div className="project-toggle" onClick={() => setShowProjects((v) => !v)}>
        <span>项目</span>
        <span className="chev">{showProjects ? "▾" : "▸"}</span>
      </div>

      {showProjects && (
        <div className="project-list">
          <button
            className={`project-chip ${activeProject === null ? "active" : ""}`}
            onClick={() => onProject(null)}
          >
            全部 <span className="count">{sessions.length}</span>
          </button>
          {projects.map((p) => (
            <button
              key={p.key}
              className={`project-chip ${activeProject === p.key ? "active" : ""}`}
              onClick={() => onProject(p.key)}
              title={p.label}
            >
              <span className="proj-name">{shortPath(p.label)}</span>
              <span className="count">{p.session_count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="session-scroll">
        {grouped.length === 0 && (
          <div className="empty-hint">{loading ? "正在扫描…" : "没有匹配的会话"}</div>
        )}
        {grouped.map(([key, list]) => (
          <div key={key} className="session-group">
            <div className="group-head">{shortPath(list[0].cwd || key)}</div>
            {list.map((s) => (
              <SessionRow
                key={s.path}
                s={s}
                active={s.path === selectedPath}
                onClick={() => onSelect(s.path)}
              />
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}

function SessionRow({
  s,
  active,
  onClick,
}: {
  s: SessionSummary;
  active: boolean;
  onClick: () => void;
}) {
  const title = s.name || s.first_user_message || `会话 ${s.id.slice(0, 8)}`;
  return (
    <button className={`session-row ${active ? "active" : ""}`} onClick={onClick}>
      <div className="row-top">
        <span className="row-title">{truncate(title, 60)}</span>
        {s.has_errors && <span className="err-dot" title="包含错误" />}
      </div>
      <div className="row-meta">
        <span className="row-time">{formatRelative(s.updated_at)}</span>
        <span className="dot">·</span>
        <span>{s.message_count} 条</span>
        {s.tool_call_count > 0 && (
          <>
            <span className="dot">·</span>
            <span>{s.tool_call_count} 工具</span>
          </>
        )}
        <span className="dot">·</span>
        <span>{formatBytes(s.size_bytes)}</span>
      </div>
      {s.model && <div className="row-model">{s.model}</div>}
    </button>
  );
}

function truncate(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

export function shortPath(p: string): string {
  if (!p) return "";
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return "…/" + parts.slice(-2).join("/");
}
