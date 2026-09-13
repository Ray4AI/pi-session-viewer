import { invoke } from "@tauri-apps/api/core";
import type {
  ProjectGroup,
  SearchResponse,
  SessionDetail,
  SessionSummary,
} from "./types";

export const api = {
  listSessions: (root?: string) =>
    invoke<SessionSummary[]>("list_sessions", { root: root ?? null }),
  loadSession: (path: string) =>
    invoke<SessionDetail>("load_session", { path }),
  defaultSessionsRoot: () => invoke<string>("default_sessions_root"),
  listProjects: (root?: string) =>
    invoke<ProjectGroup[]>("list_projects", { root: root ?? null }),
  searchSessions: (root: string | undefined, query: string, limit?: number) =>
    invoke<SearchResponse>("search_sessions", {
      root: root ?? null,
      query,
      limit: limit ?? null,
    }),
};

/** Detect whether we're running inside a Tauri webview. */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
