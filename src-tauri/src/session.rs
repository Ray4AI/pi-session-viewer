//! Pi session JSONL parsing and directory scanning.
//!
//! Sessions are JSONL files under `~/.pi/agent/sessions/--<cwd-slug>--/`.
//! Each line is a JSON object with a `type` field. Entries form a tree via
//! `id`/`parentId`. See docs/session-format.md in pi-coding-agent.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// A parsed session entry as it appears on one JSONL line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawEntry {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(rename = "parentId", default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(flatten)]
    pub rest: serde_json::Map<String, Value>,
}

/// Lightweight session metadata used by the session list.
#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub path: String,
    pub id: String,
    pub name: Option<String>,
    pub cwd: String,
    pub project_key: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub size_bytes: u64,
    pub entry_count: usize,
    pub message_count: usize,
    pub user_message_count: usize,
    pub assistant_message_count: usize,
    pub tool_call_count: usize,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub first_user_message: Option<String>,
    pub has_errors: bool,
    pub version: Option<u64>,
}

/// Full parsed session returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct SessionDetail {
    pub summary: SessionSummary,
    pub entries: Vec<RawEntry>,
    pub session_id: Option<String>,
}

fn sessions_root() -> PathBuf {
    if let Ok(custom) = std::env::var("PI_SESSIONS_DIR") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    let home = dirs_home();
    home.join(".pi").join("agent").join("sessions")
}

fn dirs_home() -> PathBuf {
    if let Ok(h) = std::env::var("USERPROFILE") {
        if !h.trim().is_empty() {
            return PathBuf::from(h);
        }
    }
    if let Ok(h) = std::env::var("HOME") {
        if !h.trim().is_empty() {
            return PathBuf::from(h);
        }
    }
    PathBuf::from(".")
}

/// Convert a `--root-workspace--` directory name back into a path-like label.
pub fn project_label_from_dir(dir_name: &str) -> String {
    let inner = dir_name
        .trim_start_matches("--")
        .trim_end_matches("--")
        .to_string();
    if inner.is_empty() {
        return "/".to_string();
    }
    // Directory names replace '/' with '-'. Restore a best-effort label.
    if inner == "root" {
        return "/root".to_string();
    }
    format!("/{}", inner.replace('-', "/"))
}

/// Truncate a string to at most `max` chars, adding an ellipsis.
fn truncate(s: &str, max: usize) -> String {
    let cleaned = s.trim();
    let mut out = String::new();
    for (i, ch) in cleaned.chars().enumerate() {
        if i >= max {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

/// Extract plain text from a message `content` value (string or content blocks).
fn extract_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            let mut parts: Vec<String> = Vec::new();
            for item in items {
                if let Value::Object(obj) = item {
                    match obj.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = obj.get("text").and_then(|v| v.as_str()) {
                                parts.push(t.to_string());
                            }
                        }
                        Some("thinking") => {
                            if let Some(t) = obj.get("thinking").and_then(|v| v.as_str()) {
                                parts.push(t.to_string());
                            }
                        }
                        _ => {}
                    }
                }
            }
            parts.join("\n")
        }
        _ => String::new(),
    }
}

/// Parse a single JSONL file into its entries and summary.
pub fn parse_session_file(path: &Path) -> Result<SessionDetail, String> {
    let file = fs::File::open(path).map_err(|e| format!("打开文件失败: {e}"))?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let reader = BufReader::new(file);

    let mut entries: Vec<RawEntry> = Vec::new();
    let mut session_header: Option<Value> = None;
    let mut parse_errors = 0usize;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => {
                parse_errors += 1;
                continue;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<RawEntry>(trimmed) {
            Ok(entry) => {
                if entry.kind == "session" {
                    session_header = serde_json::from_str::<Value>(trimmed).ok();
                }
                entries.push(entry);
            }
            Err(_) => {
                parse_errors += 1;
            }
        }
    }

    // Aggregate summary fields.
    let mut name: Option<String> = None;
    let mut first_user_message: Option<String> = None;
    let mut message_count = 0usize;
    let mut user_count = 0usize;
    let mut assistant_count = 0usize;
    let mut tool_call_count = 0usize;
    let mut has_errors = false;

    let mut last_model: Option<String> = None;
    let mut last_provider: Option<String> = None;

    for entry in &entries {
        match entry.kind.as_str() {
            "session_info" => {
                if let Some(n) = entry.rest.get("name").and_then(|v| v.as_str()) {
                    name = Some(n.to_string());
                }
            }
            "model_change" => {
                last_provider = entry
                    .rest
                    .get("provider")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                last_model = entry
                    .rest
                    .get("modelId")
                    .and_then(|v| v.as_str())
                    .map(String::from);
            }
            "message" => {
                message_count += 1;
                let msg = entry.rest.get("message");
                let role = msg
                    .and_then(|m| m.get("role"))
                    .and_then(|r| r.as_str())
                    .unwrap_or("");
                match role {
                    "user" => {
                        user_count += 1;
                        if first_user_message.is_none() {
                            if let Some(content) = msg.and_then(|m| m.get("content")) {
                                let text = extract_text(content);
                                if !text.trim().is_empty() {
                                    first_user_message = Some(truncate(&text, 200));
                                }
                            }
                        }
                    }
                    "assistant" => {
                        assistant_count += 1;
                        if let Some(content) = msg.and_then(|m| m.get("content")) {
                            if let Value::Array(items) = content {
                                for item in items {
                                    if item.get("type").and_then(|t| t.as_str()) == Some("toolCall") {
                                        tool_call_count += 1;
                                    }
                                }
                            }
                        }
                        if msg
                            .and_then(|m| m.get("stopReason"))
                            .and_then(|s| s.as_str())
                            == Some("error")
                        {
                            has_errors = true;
                        }
                    }
                    "toolResult" => {
                        let _ = msg
                            .and_then(|m| m.get("isError"))
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        // Tool-level failures (e.g. grep exit 1) are not session
                        // errors; they are rendered inline on the tool call.
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    // Latest model_change wins; fall back to the assistant message metadata.
    let mut model = last_model;
    let mut provider = last_provider;
    if model.is_none() {
        for entry in entries.iter().rev() {
            if entry.kind == "message" {
                if let Some(msg) = entry.rest.get("message") {
                    if msg.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                        model = msg.get("model").and_then(|v| v.as_str()).map(String::from);
                        provider = msg.get("provider").and_then(|v| v.as_str()).map(String::from);
                        if model.is_some() {
                            break;
                        }
                    }
                }
            }
        }
    }

    let header_cwd = session_header
        .as_ref()
        .and_then(|h| h.get("cwd"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let version = session_header
        .as_ref()
        .and_then(|h| h.get("version"))
        .and_then(|v| v.as_u64());
    let session_id = session_header
        .as_ref()
        .and_then(|h| h.get("id"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.split('_').nth(1))
                .map(String::from)
        });

    let project_dir = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let project_key = project_label_from_dir(project_dir);
    let cwd = if header_cwd.is_empty() {
        project_key.clone()
    } else {
        header_cwd
    };

    let created_at = session_header
        .as_ref()
        .and_then(|h| h.get("timestamp"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| entries.first().and_then(|e| e.timestamp.clone()));
    let updated_at = entries
        .iter()
        .rev()
        .find_map(|e| e.timestamp.clone())
        .or_else(|| created_at.clone());

    if parse_errors > 0 {
        has_errors = true;
    }

    let summary = SessionSummary {
        path: path.to_string_lossy().to_string(),
        id: session_id.clone().unwrap_or_default(),
        name,
        cwd,
        project_key,
        created_at,
        updated_at,
        size_bytes: size,
        entry_count: entries.len(),
        message_count,
        user_message_count: user_count,
        assistant_message_count: assistant_count,
        tool_call_count,
        model,
        provider,
        first_user_message,
        has_errors,
        version,
    };

    Ok(SessionDetail {
        summary,
        entries,
        session_id,
    })
}

/// Recursively find all `.jsonl` files under a root directory.
fn find_jsonl_files(root: &Path, out: &mut Vec<PathBuf>) {
    let rd = match fs::read_dir(root) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            find_jsonl_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

/// Resolve the effective root: explicit argument wins over the default.
fn resolve_root(root: Option<String>) -> PathBuf {
    match root {
        Some(r) if !r.trim().is_empty() => PathBuf::from(r),
        _ => sessions_root(),
    }
}

/// List all sessions under a root directory (default: pi sessions dir).
#[tauri::command]
pub fn list_sessions(root: Option<String>) -> Result<Vec<SessionSummary>, String> {
    let base = resolve_root(root);
    if !base.exists() {
        return Err(format!("目录不存在: {}", base.to_string_lossy()));
    }
    let mut files: Vec<PathBuf> = Vec::new();
    find_jsonl_files(&base, &mut files);

    let mut summaries: Vec<SessionSummary> = Vec::new();
    for file in files {
        if let Ok(detail) = parse_session_file(&file) {
            summaries.push(detail.summary);
        }
    }
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

/// Load a single session by absolute path.
#[tauri::command]
pub fn load_session(path: String) -> Result<SessionDetail, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {path}"));
    }
    parse_session_file(&p)
}

/// Return the default sessions root so the UI can show it.
#[tauri::command]
pub fn default_sessions_root() -> String {
    sessions_root().to_string_lossy().to_string()
}

/// Recursively count `.jsonl` files under a directory (used to validate a pick).
#[tauri::command]
pub fn count_sessions(root: String) -> Result<usize, String> {
    let base = PathBuf::from(&root);
    if !base.exists() {
        return Err(format!("目录不存在: {root}"));
    }
    let mut files = Vec::new();
    find_jsonl_files(&base, &mut files);
    Ok(files.len())
}

/// Group summaries by project for the sidebar.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectGroup {
    pub key: String,
    pub label: String,
    pub session_count: usize,
    pub last_updated: Option<String>,
}

#[tauri::command]
pub fn list_projects(root: Option<String>) -> Result<Vec<ProjectGroup>, String> {
    let sessions = list_sessions(root)?;
    let mut map: HashMap<String, ProjectGroup> = HashMap::new();
    for s in sessions {
        let entry = map.entry(s.project_key.clone()).or_insert_with(|| ProjectGroup {
            key: s.project_key.clone(),
            label: s.cwd.clone(),
            session_count: 0,
            last_updated: None,
        });
        entry.session_count += 1;
        if entry.last_updated.is_none() || s.updated_at > entry.last_updated {
            entry.last_updated = s.updated_at.clone();
        }
    }
    let mut groups: Vec<ProjectGroup> = map.into_values().collect();
    groups.sort_by(|a, b| b.last_updated.cmp(&a.last_updated));
    Ok(groups)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_sample(dir: &Path) -> PathBuf {
        let file = dir.join("--root-workspace--").join("2026-01-01T00-00-00-000Z_abc.jsonl");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        let lines = vec![
            r#"{"type":"session","version":3,"id":"abc","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/root/workspace"}"#,
            r#"{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","provider":"anthropic","modelId":"claude-sonnet-4-5"}"#,
            r#"{"type":"message","id":"u1","parentId":"m1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"user","content":[{"type":"text","text":"hello world"}],"timestamp":1}}"#,
            r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"let me think"},{"type":"text","text":"hi"},{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"ls"}}],"provider":"anthropic","model":"claude-sonnet-4-5","usage":{"input":10,"output":5,"cacheRead":2,"cacheWrite":1,"totalTokens":18,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0.001}},"stopReason":"toolUse","timestamp":2}}"#,
            r#"{"type":"message","id":"r1","parentId":"a1","timestamp":"2026-01-01T00:00:04.000Z","message":{"role":"toolResult","toolCallId":"t1","toolName":"bash","content":[{"type":"text","text":"file.txt"}],"isError":false,"timestamp":3}}"#,
            r#"{"type":"session_info","id":"s1","parentId":"r1","timestamp":"2026-01-01T00:00:05.000Z","name":"我的测试会话"}"#,
        ];
        let mut f = fs::File::create(&file).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        file
    }

    #[test]
    fn parses_summary_fields() {
        let tmp = std::env::temp_dir().join(format!("pisv-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let file = write_sample(&tmp);
        let detail = parse_session_file(&file).unwrap();
        assert_eq!(detail.summary.name.as_deref(), Some("我的测试会话"));
        assert_eq!(detail.summary.message_count, 3);
        assert_eq!(detail.summary.user_message_count, 1);
        assert_eq!(detail.summary.assistant_message_count, 1);
        assert_eq!(detail.summary.tool_call_count, 1);
        assert_eq!(detail.summary.model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(detail.summary.cwd, "/root/workspace");
        assert_eq!(detail.summary.version, Some(3));
        assert_eq!(detail.summary.first_user_message.as_deref(), Some("hello world"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn lists_and_groups_sessions() {
        let tmp = std::env::temp_dir().join(format!("pisv-test-list-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        write_sample(&tmp);
        let list = list_sessions(Some(tmp.to_string_lossy().to_string())).unwrap();
        assert_eq!(list.len(), 1);
        let groups = list_projects(Some(tmp.to_string_lossy().to_string())).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].session_count, 1);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn project_label_roundtrip() {
        assert_eq!(project_label_from_dir("--root--"), "/root");
        assert_eq!(project_label_from_dir("--root-workspace--"), "/root/workspace");
    }

    #[test]
    fn missing_dir_errors() {
        assert!(list_sessions(Some("/nonexistent/path/xyz".into())).is_err());
    }
}
