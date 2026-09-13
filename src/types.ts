// Shared types mirroring the Rust session structures.

export interface SessionSummary {
  path: string;
  id: string;
  name: string | null;
  cwd: string;
  project_key: string;
  created_at: string | null;
  updated_at: string | null;
  size_bytes: number;
  entry_count: number;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  tool_call_count: number;
  model: string | null;
  provider: string | null;
  first_user_message: string | null;
  has_errors: boolean;
  version: number | null;
}

export interface RawEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  [key: string]: unknown;
}

export interface SessionDetail {
  summary: SessionSummary;
  entries: RawEntry[];
  session_id: string | null;
}

export interface ProjectGroup {
  key: string;
  label: string;
  session_count: number;
  last_updated: string | null;
}

// --- Content blocks ---

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | ThinkingContent
  | ToolCall
  | { type: string; [key: string]: unknown };

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface AgentMessage {
  role: string;
  content: string | ContentBlock[];
  timestamp?: number;
  // assistant
  api?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  stopReason?: string;
  errorMessage?: string;
  // toolResult
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  // custom
  customType?: string;
  display?: boolean;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  hasUsage: boolean;
}
