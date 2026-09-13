import { useEffect, useMemo, useRef, useState } from "react";
import { api, isTauri } from "../api";
import type { DocRole, SearchHit, SearchResponse } from "../types";
import {
  ROLE_META,
  composeQuery,
  formatRelative,
  roleMeta,
  splitSnippet,
} from "../sessionModel";
import { shortPath } from "./Sidebar";

interface Props {
  root: string;
  /** Bumped by the parent to force a re-run (e.g. after refresh). */
  refreshToken: number;
  onOpenHit: (hit: SearchHit) => void;
}

const ROLE_ORDER: DocRole[] = [
  "user",
  "assistant",
  "thinking",
  "toolCall",
  "toolResult",
  "event",
];

export function SearchPanel({ root, refreshToken, onOpenHit }: Props) {
  const [text, setText] = useState("");
  const [roles, setRoles] = useState<DocRole[]>([]);
  const [excludeRoles, setExcludeRoles] = useState<DocRole[]>([]);
  const [resp, setResp] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [groupBySession, setGroupBySession] = useState(true);
  const [searching, setSearching] = useState(false);
  const reqId = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search whenever the query or filters change.
  useEffect(() => {
    const active =
      text.trim().length > 0 || roles.length > 0 || excludeRoles.length > 0;
    if (!active) {
      setResp(null);
      setSearching(false);
      return;
    }
    const id = ++reqId.current;
    setSearching(true);
    const t = setTimeout(async () => {
      if (!isTauri) return;
      setLoading(true);
      setError(null);
      try {
        const query = composeQuery(text, roles, { excludeRoles });
        const r = await api.searchSessions(root || undefined, query);
        if (reqId.current === id) setResp(r);
      } catch (e) {
        if (reqId.current === id) setError(String(e));
      } finally {
        if (reqId.current === id) {
          setLoading(false);
          setSearching(false);
        }
      }
    }, 220);
    return () => clearTimeout(t);
  }, [text, roles, excludeRoles, root, refreshToken]);

  // Ctrl/Cmd+K focuses the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleRole = (r: DocRole) => {
    setRoles((prev) =>
      prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r],
    );
    setExcludeRoles((prev) => prev.filter((x) => x !== r));
  };
  const toggleExcludeRole = (r: DocRole) => {
    setExcludeRoles((prev) =>
      prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r],
    );
    setRoles((prev) => prev.filter((x) => x !== r));
  };

  const clearAll = () => {
    setText("");
    setRoles([]);
    setExcludeRoles([]);
    setResp(null);
    inputRef.current?.focus();
  };

  const grouped = useMemo(() => {
    if (!resp) return [];
    if (!groupBySession) {
      return [["", resp.hits]] as [string, SearchHit[]][];
    }
    const map = new Map<string, SearchHit[]>();
    for (const h of resp.hits) {
      if (!map.has(h.sessionPath)) map.set(h.sessionPath, []);
      map.get(h.sessionPath)!.push(h);
    }
    return [...map.entries()];
  }, [resp, groupBySession]);

  const hasQuery =
    text.trim().length > 0 || roles.length > 0 || excludeRoles.length > 0;

  return (
    <div className="search-panel">
      <div className="search-input-row">
        <span className="search-icon">🔍</span>
        <input
          ref={inputRef}
          className="search-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='搜索会话内容…  支持 role:user、"精确短语"、-排除'
          spellCheck={false}
        />
        {hasQuery && (
          <button className="search-clear" onClick={clearAll} title="清空">
            ×
          </button>
        )}
        <button
          className={`filter-toggle ${showFilters ? "active" : ""}`}
          onClick={() => setShowFilters((v) => !v)}
          title="角色筛选"
        >
          筛选
          {(roles.length > 0 || excludeRoles.length > 0) && (
            <span className="filter-count">
              {roles.length + excludeRoles.length}
            </span>
          )}
        </button>
      </div>

      {showFilters && (
        <div className="filter-panel">
          <div className="filter-group">
            <div className="filter-label">
              仅显示 <span className="filter-hint">点击切换</span>
            </div>
            <div className="filter-chips">
              {ROLE_META.map((r) => (
                <button
                  key={r.key}
                  className={`chip ${r.className} ${roles.includes(r.key) ? "on" : ""}`}
                  onClick={() => toggleRole(r.key)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-group">
            <div className="filter-label">
              排除 <span className="filter-hint">点击排除该角色</span>
            </div>
            <div className="filter-chips">
              {ROLE_META.map((r) => (
                <button
                  key={r.key}
                  className={`chip ${r.className} ${excludeRoles.includes(r.key) ? "exclude" : ""}`}
                  onClick={() => toggleExcludeRole(r.key)}
                  title={`排除 ${r.label}`}
                >
                  {r.short}
                </button>
              ))}
            </div>
          </div>
          <label className="filter-check">
            <input
              type="checkbox"
              checked={groupBySession}
              onChange={(e) => setGroupBySession(e.target.checked)}
            />
            按会话分组
          </label>
        </div>
      )}

      {error && <div className="search-error">{error}</div>}

      {resp && (
        <div className="search-meta">
          <span>
            {resp.filterOnly ? (
              <>
                共 <b>{resp.total}</b> 条匹配
              </>
            ) : (
              <>
                找到 <b>{resp.total}</b> 条匹配
              </>
            )}
            {resp.truncated && (
              <span className="trunc">（仅显示前 {resp.hits.length} 条）</span>
            )}
          </span>
          <span className="search-time">
            {resp.filesScanned} 个会话 · {resp.tookMs}ms
          </span>
        </div>
      )}

      {resp && resp.hits.length > 0 && (
        <div className="role-summary">
          {ROLE_ORDER.filter((r) => (resp.counts[r] ?? 0) > 0).map((r) => {
            const m = roleMeta(r);
            return (
              <button
                key={r}
                className={`role-count ${m.className}`}
                onClick={() => toggleRole(r)}
                title={`仅看${m.label}`}
              >
                {m.label} <b>{resp.counts[r]}</b>
              </button>
            );
          })}
        </div>
      )}

      <div className="search-results">
        {searching && loading && <div className="search-loading">搜索中…</div>}
        {resp && resp.hits.length === 0 && !loading && (
          <div className="search-empty">
            <div className="search-empty-mark">∅</div>
            <div>没有找到匹配的内容</div>
            <div className="search-empty-hint">
              试试更短的关键词，或去掉角色筛选
            </div>
          </div>
        )}

        {grouped.map(([path, list]) => (
          <div key={path || "_flat"} className="result-group">
            {path && (
              <div className="result-group-head">
                {shortPath(list[0].cwd || path)}
              </div>
            )}
            {path && (
              <div className="result-group-title" title={list[0].sessionTitle}>
                {list[0].sessionTitle}
                <span className="result-group-count">{list.length}</span>
              </div>
            )}
            {list.map((h, i) => (
              <HitRow
                key={`${h.sessionPath}:${h.entryId}:${h.role}:${i}`}
                hit={h}
                onOpen={onOpenHit}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function HitRow({
  hit,
  onOpen,
}: {
  hit: SearchHit;
  onOpen: (h: SearchHit) => void;
}) {
  const meta = roleMeta(hit.role);
  const segs = splitSnippet(hit.snippet, hit.highlights);
  return (
    <button
      className="hit"
      onClick={() => onOpen(hit)}
      title="点击跳转到该消息"
    >
      <div className="hit-head">
        <span className={`hit-role ${meta.className}`}>{meta.short}</span>
        {hit.toolName && <span className="hit-tool">{hit.toolName}</span>}
        <span className="hit-time">
          {formatRelative(hit.timestamp ?? hit.updatedAt)}
        </span>
        {hit.occurrences > 1 && (
          <span className="hit-count">{hit.occurrences} 处</span>
        )}
      </div>
      <div className="hit-snippet">
        {segs.map((s, i) =>
          s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>,
        )}
      </div>
    </button>
  );
}
