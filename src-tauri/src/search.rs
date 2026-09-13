//! Full-text search across session contents.
//!
//! Builds an in-memory index of every searchable content block (user text,
//! assistant text, thinking, tool calls, tool results, events) keyed by file
//! path + mtime + size, so repeat searches do not re-parse the JSONL files.
//!
//! Query syntax (all optional, combinable):
//!   role:user | role:assistant | role:thinking | role:tool | role:result | role:event
//!   model:<substring>
//!   project:<substring>
//!   "exact phrase"
//!   -excluded
//!   free terms (all must match, case-insensitive substring)

use crate::session::{
    extract_text, find_jsonl_files, parse_session_file, resolve_root, SessionDetail,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

/// Role of a searchable document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocRole {
    User,
    Assistant,
    Thinking,
    ToolCall,
    ToolResult,
    Event,
}

impl DocRole {
    fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "user" | "u" => Some(Self::User),
            "assistant" | "ai" | "a" => Some(Self::Assistant),
            "thinking" | "think" | "t" => Some(Self::Thinking),
            "tool" | "toolcall" | "call" => Some(Self::ToolCall),
            "result" | "toolresult" | "r" => Some(Self::ToolResult),
            "event" | "e" => Some(Self::Event),
            _ => None,
        }
    }

    fn weight(self) -> f64 {
        match self {
            Self::User => 12.0,
            Self::Assistant => 10.0,
            Self::Thinking => 3.0,
            Self::ToolCall => 4.0,
            Self::ToolResult => 2.0,
            Self::Event => 1.0,
        }
    }
}

#[derive(Debug, Clone)]
struct Doc {
    role: DocRole,
    text: String,
    entry_id: String,
    timestamp: Option<String>,
    tool_name: Option<String>,
}

#[derive(Debug, Clone)]
struct CachedFile {
    mtime: u64,
    size: u64,
    /// Metadata used for result headers without re-reading the file.
    name: Option<String>,
    cwd: String,
    project_key: String,
    updated_at: Option<String>,
    model: Option<String>,
    title: String,
    docs: Vec<Doc>,
}

/// Tauri-managed cache. Keyed by absolute file path.
#[derive(Default)]
pub struct SearchCache {
    files: Mutex<HashMap<String, CachedFile>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session_path: String,
    pub session_id: String,
    pub session_name: Option<String>,
    pub session_title: String,
    pub cwd: String,
    pub project_key: String,
    pub updated_at: Option<String>,
    pub role: DocRole,
    pub entry_id: String,
    pub timestamp: Option<String>,
    pub tool_name: Option<String>,
    /// Snippet with the first match in context.
    pub snippet: String,
    /// Byte offsets into `snippet` that should be highlighted.
    pub highlights: Vec<[usize; 2]>,
    pub score: f64,
    pub occurrences: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    /// Total matches found before truncation.
    pub total: usize,
    pub truncated: bool,
    /// Match counts per role, before truncation.
    pub counts: HashMap<String, usize>,
    pub files_scanned: usize,
    pub files_parsed: usize,
    pub took_ms: u64,
    /// Set when the query only had filters and no searchable terms.
    pub filter_only: bool,
}

// ---------------------------------------------------------------- query parse

#[derive(Debug, Default)]
struct Query {
    terms: Vec<String>,
    phrases: Vec<String>,
    excluded: Vec<String>,
    roles: Vec<DocRole>,
    excluded_roles: Vec<DocRole>,
    models: Vec<String>,
    projects: Vec<String>,
    excluded_models: Vec<String>,
    excluded_projects: Vec<String>,
}

impl Query {
    fn has_text_terms(&self) -> bool {
        !self.terms.is_empty() || !self.phrases.is_empty()
    }

    /// True when there is nothing to match against body text.
    fn is_filter_only(&self) -> bool {
        !self.has_text_terms() && self.excluded.is_empty()
    }
}

/// Split a query into tokens, honoring double quotes.
fn tokenize(q: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    for ch in q.chars() {
        match ch {
            '"' => {
                if in_quote {
                    out.push(cur.clone());
                    cur.clear();
                }
                in_quote = !in_quote;
            }
            c if c.is_whitespace() && !in_quote => {
                if !cur.is_empty() {
                    out.push(cur.clone());
                    cur.clear();
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn parse_query(raw: &str) -> Query {
    let mut q = Query::default();
    for tok in tokenize(raw) {
        if tok.is_empty() {
            continue;
        }
        // Quoted strings become phrases (exact).
        if tok.contains(' ') {
            q.phrases.push(tok.to_lowercase());
            continue;
        }
        let (neg, body) = match tok.strip_prefix('-') {
            Some(rest) if !rest.is_empty() => (true, rest),
            _ => (false, tok.as_str()),
        };
        if let Some((key, val)) = body.split_once(':') {
            if !val.is_empty() {
                match key.to_ascii_lowercase().as_str() {
                    "role" | "r" => {
                        // Support role:user+assistant and -role:toolResult
                        for part in val.split('+') {
                            if let Some(r) = DocRole::parse(part) {
                                let bucket = if neg {
                                    &mut q.excluded_roles
                                } else {
                                    &mut q.roles
                                };
                                if !bucket.contains(&r) {
                                    bucket.push(r);
                                }
                            }
                        }
                        continue;
                    }
                    "model" | "m" => {
                        let v = val.to_lowercase();
                        if neg {
                            q.excluded_models.push(v);
                        } else {
                            q.models.push(v);
                        }
                        continue;
                    }
                    "project" | "cwd" | "p" => {
                        let v = val.to_lowercase();
                        if neg {
                            q.excluded_projects.push(v);
                        } else {
                            q.projects.push(v);
                        }
                        continue;
                    }
                    _ => {}
                }
            }
        }
        let lower = body.to_lowercase();
        if neg {
            q.excluded.push(lower);
        } else {
            q.terms.push(lower);
        }
    }
    q
}

// -------------------------------------------------------------- ci searching

/// Case-insensitive (char-wise, 1:1) character compare of `needle` at `start`.
fn matches_at(hay: &str, start: usize, needle: &[char]) -> bool {
    if needle.is_empty() {
        return false;
    }
    let mut it = hay[start..].chars();
    for &nc in needle {
        match it.next() {
            Some(hc) => {
                let lc = hc.to_lowercase().next().unwrap_or(hc);
                if lc != nc {
                    return false;
                }
            }
            None => return false,
        }
    }
    true
}

/// First byte offset of `needle` in `hay` at or after `from`, case-insensitive.
fn find_ci(hay: &str, needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let len = hay.len();
    let mut pos = from;
    while pos <= len {
        if matches_at(hay, pos, needle) {
            return Some(pos);
        }
        match hay[pos..].chars().next() {
            Some(c) => pos += c.len_utf8(),
            None => break,
        }
    }
    None
}

/// All byte-offset ranges of `needle` in `hay`, capped at `max`.
fn find_all_ci(hay: &str, needle: &[char], max: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    if needle.is_empty() {
        return out;
    }
    let mut from = 0usize;
    while out.len() < max {
        match find_ci(hay, needle, from) {
            Some(start) => {
                // advance by the byte length of the matched slice
                let end = hay[start..]
                    .char_indices()
                    .nth(needle.len())
                    .map(|(i, _)| start + i)
                    .unwrap_or(hay.len());
                out.push((start, end));
                from = if end > start { end } else { start + 1 };
                if from > hay.len() {
                    break;
                }
            }
            None => break,
        }
    }
    out
}

fn to_chars(needle: &str) -> Vec<char> {
    needle
        .chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

/// Build a char-window snippet around the earliest match and return highlight
/// ranges relative to the snippet.
fn build_snippet(
    text: &str,
    first_byte: usize,
    ranges: &[(usize, usize)],
) -> (String, Vec<[usize; 2]>) {
    const BEFORE: usize = 34;
    const AFTER: usize = 110;

    let chars: Vec<char> = text.chars().collect();
    let first_char = text[..first_byte.min(text.len())].chars().count();
    let start = first_char.saturating_sub(BEFORE);
    let end = (start + AFTER).min(chars.len());

    let mut snippet: String = chars[start..end].iter().collect();
    let prefix_len = if start > 0 { "…".chars().count() } else { 0 };
    if start > 0 {
        snippet.insert(0, '…');
    }
    if end < chars.len() {
        snippet.push('…');
    }

    // Map byte ranges -> char ranges, then shift into snippet space.
    let mut highlights = Vec::new();
    for &(bs, be) in ranges {
        let cs = text[..bs.min(text.len())].chars().count();
        let ce = text[..be.min(text.len())].chars().count();
        if ce <= start || cs >= end {
            continue;
        }
        let s = cs.max(start) - start + prefix_len;
        let e = ce.min(end) - start + prefix_len;
        highlights.push([s, e]);
    }
    (snippet, highlights)
}

// ------------------------------------------------------------- index building

fn push_doc(
    docs: &mut Vec<Doc>,
    role: DocRole,
    text: String,
    entry_id: &str,
    timestamp: &Option<String>,
    tool_name: Option<String>,
) {
    if text.trim().is_empty() {
        return;
    }
    docs.push(Doc {
        role,
        text,
        entry_id: entry_id.to_string(),
        timestamp: timestamp.clone(),
        tool_name,
    });
}

fn value_str(v: &Value) -> String {
    v.as_str().map(String::from).unwrap_or_default()
}

fn docs_from_detail(detail: &SessionDetail) -> Vec<Doc> {
    let mut docs = Vec::new();
    for entry in &detail.entries {
        let id = entry.id.clone().unwrap_or_default();
        let ts = entry.timestamp.clone();
        match entry.kind.as_str() {
            "message" => {
                let Some(msg) = entry.rest.get("message") else {
                    continue;
                };
                let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
                let content = msg.get("content").unwrap_or(&Value::Null);
                match role {
                    "user" => {
                        push_doc(
                            &mut docs,
                            DocRole::User,
                            extract_text(content),
                            &id,
                            &ts,
                            None,
                        );
                    }
                    "assistant" => {
                        if let Some(blocks) = content.as_array() {
                            for b in blocks {
                                match b.get("type").and_then(|t| t.as_str()) {
                                    Some("text") => push_doc(
                                        &mut docs,
                                        DocRole::Assistant,
                                        value_str(b.get("text").unwrap_or(&Value::Null)),
                                        &id,
                                        &ts,
                                        None,
                                    ),
                                    Some("thinking") => push_doc(
                                        &mut docs,
                                        DocRole::Thinking,
                                        value_str(b.get("thinking").unwrap_or(&Value::Null)),
                                        &id,
                                        &ts,
                                        None,
                                    ),
                                    Some("toolCall") => {
                                        let name = value_str(b.get("name").unwrap_or(&Value::Null));
                                        let args = b
                                            .get("arguments")
                                            .map(|a| serde_json::to_string(a).unwrap_or_default())
                                            .unwrap_or_default();
                                        push_doc(
                                            &mut docs,
                                            DocRole::ToolCall,
                                            format!("{name} {args}"),
                                            &id,
                                            &ts,
                                            Some(name),
                                        );
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                    "toolResult" => {
                        let name = value_str(msg.get("toolName").unwrap_or(&Value::Null));
                        let text = extract_text(content);
                        push_doc(
                            &mut docs,
                            DocRole::ToolResult,
                            format!("{name} {text}"),
                            &id,
                            &ts,
                            Some(name),
                        );
                    }
                    "custom" => {
                        push_doc(
                            &mut docs,
                            DocRole::Event,
                            extract_text(content),
                            &id,
                            &ts,
                            None,
                        );
                    }
                    _ => {}
                }
            }
            "compaction" | "branch_summary" => push_doc(
                &mut docs,
                DocRole::Event,
                value_str(entry.rest.get("summary").unwrap_or(&Value::Null)),
                &id,
                &ts,
                None,
            ),
            "model_change" => push_doc(
                &mut docs,
                DocRole::Event,
                format!(
                    "{} {}",
                    value_str(entry.rest.get("provider").unwrap_or(&Value::Null)),
                    value_str(entry.rest.get("modelId").unwrap_or(&Value::Null))
                ),
                &id,
                &ts,
                None,
            ),
            "custom_message" => {
                let content = entry.rest.get("content").unwrap_or(&Value::Null);
                let text = match content {
                    Value::String(s) => s.clone(),
                    other => extract_text(other),
                };
                push_doc(&mut docs, DocRole::Event, text, &id, &ts, None);
            }
            "custom" => push_doc(
                &mut docs,
                DocRole::Event,
                entry
                    .rest
                    .get("data")
                    .map(|d| serde_json::to_string(d).unwrap_or_default())
                    .unwrap_or_default(),
                &id,
                &ts,
                None,
            ),
            _ => {}
        }
    }
    docs
}

fn file_stamp(path: &Path) -> (u64, u64) {
    match std::fs::metadata(path) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            (mtime, m.len())
        }
        Err(_) => (0, 0),
    }
}

fn build_cache_entry(path: &Path, detail: &SessionDetail) -> CachedFile {
    let (mtime, size) = file_stamp(path);
    let s = &detail.summary;
    CachedFile {
        mtime,
        size,
        name: s.name.clone(),
        cwd: s.cwd.clone(),
        project_key: s.project_key.clone(),
        updated_at: s.updated_at.clone(),
        model: s.model.clone(),
        title: s
            .name
            .clone()
            .or_else(|| s.first_user_message.clone())
            .unwrap_or_else(|| format!("会话 {}", s.id.chars().take(8).collect::<String>())),
        docs: docs_from_detail(detail),
    }
}

// ------------------------------------------------------------------- matching

/// Does this text satisfy all terms/phrases and no excluded term?
/// Returns (occurrences, all byte ranges).
fn match_text(text: &str, q: &Query) -> Option<(usize, Vec<(usize, usize)>)> {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut occurrences = 0usize;

    for phrase in &q.phrases {
        let chars = to_chars(phrase);
        let found = find_all_ci(text, &chars, 200);
        if found.is_empty() {
            return None;
        }
        occurrences += found.len();
        ranges.extend(found);
    }

    for term in &q.terms {
        let chars = to_chars(term);
        let found = find_all_ci(text, &chars, 200);
        if found.is_empty() {
            return None;
        }
        occurrences += found.len();
        ranges.extend(found);
    }

    // Text exclusions (-foo) apply to the body text.
    for ex in &q.excluded {
        if !find_all_ci(text, &to_chars(ex), 1).is_empty() {
            return None;
        }
    }

    ranges.sort_by_key(|r| r.0);
    Some((occurrences, ranges))
}

/// Frontend-facing role key, matching the TS `DocRole` union.
fn role_key(role: DocRole) -> &'static str {
    match role {
        DocRole::User => "user",
        DocRole::Assistant => "assistant",
        DocRole::Thinking => "thinking",
        DocRole::ToolCall => "toolCall",
        DocRole::ToolResult => "toolResult",
        DocRole::Event => "event",
    }
}

fn meta_matches(cache: &CachedFile, q: &Query, path: &str) -> bool {
    let hay = format!(
        "{} {} {} {} {}",
        cache.name.clone().unwrap_or_default(),
        cache.cwd,
        cache.model.clone().unwrap_or_default(),
        cache.project_key,
        path
    )
    .to_lowercase();

    for m in &q.models {
        if !hay.contains(m.as_str()) {
            return false;
        }
    }
    for p in &q.projects {
        if !hay.contains(p.as_str()) {
            return false;
        }
    }
    for m in &q.excluded_models {
        if hay.contains(m.as_str()) {
            return false;
        }
    }
    for p in &q.excluded_projects {
        if hay.contains(p.as_str()) {
            return false;
        }
    }
    true
}

// ------------------------------------------------------------------ main entry

/// Core search, factored out of the Tauri command so it is unit-testable.
fn search_core(
    root: &Path,
    raw_query: &str,
    cache: &mut HashMap<String, CachedFile>,
    limit: usize,
) -> Result<SearchResponse, String> {
    let started = std::time::Instant::now();
    if !root.exists() {
        return Err(format!("目录不存在: {}", root.to_string_lossy()));
    }

    let q = parse_query(raw_query);
    let filter_only = q.is_filter_only();

    let mut files: Vec<std::path::PathBuf> = Vec::new();
    find_jsonl_files(root, &mut files);

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut total = 0usize;
    let mut files_parsed = 0usize;

    for file in &files {
        let key = file.to_string_lossy().to_string();
        let (mtime, size) = file_stamp(file);

        let needs_parse = match cache.get(&key) {
            Some(c) => c.mtime != mtime || c.size != size || mtime == 0,
            None => true,
        };

        if needs_parse {
            let Ok(detail) = parse_session_file(file) else {
                continue;
            };
            cache.insert(key.clone(), build_cache_entry(file, &detail));
            files_parsed += 1;
        }

        let Some(cached) = cache.get(&key) else {
            continue;
        };

        if !meta_matches(cached, &q, &key) {
            continue;
        }

        for doc in &cached.docs {
            if !q.roles.is_empty() && !q.roles.contains(&doc.role) {
                continue;
            }
            if q.excluded_roles.contains(&doc.role) {
                continue;
            }

            let (occurrences, ranges, first_byte) = if filter_only {
                (0usize, Vec::new(), 0usize)
            } else {
                match match_text(&doc.text, &q) {
                    Some((occ, ranges)) => {
                        let first = ranges.first().map(|r| r.0).unwrap_or(0);
                        (occ, ranges, first)
                    }
                    None => continue,
                }
            };

            total += 1;
            *counts.entry(role_key(doc.role).to_string()).or_insert(0) += 1;

            // Title / metadata bonus.
            let mut score = doc.role.weight();
            if let Some(name) = &cached.name {
                if !filter_only
                    && find_ci(
                        name,
                        &to_chars(&q.terms.first().cloned().unwrap_or_default()),
                        0,
                    )
                    .is_some()
                {
                    score += 60.0;
                }
            }
            score += (occurrences as f64).min(20.0) * 1.5;

            let (snippet, highlights) = if filter_only {
                let chars: Vec<char> = doc.text.chars().take(140).collect();
                let mut s: String = chars.iter().collect();
                if doc.text.chars().count() > 140 {
                    s.push('…');
                }
                (s, Vec::new())
            } else {
                build_snippet(&doc.text, first_byte, &ranges)
            };

            hits.push(SearchHit {
                session_path: key.clone(),
                session_id: key
                    .rsplit('/')
                    .next()
                    .and_then(|f| f.strip_suffix(".jsonl"))
                    .and_then(|f| f.split('_').nth(1))
                    .unwrap_or("")
                    .to_string(),
                session_name: cached.name.clone(),
                session_title: cached.title.clone(),
                cwd: cached.cwd.clone(),
                project_key: cached.project_key.clone(),
                updated_at: cached.updated_at.clone(),
                role: doc.role,
                entry_id: doc.entry_id.clone(),
                timestamp: doc.timestamp.clone(),
                tool_name: doc.tool_name.clone(),
                snippet,
                highlights,
                score,
                occurrences,
            });
        }
    }

    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });

    let truncated = hits.len() > limit;
    hits.truncate(limit);

    Ok(SearchResponse {
        hits,
        total,
        truncated,
        counts,
        files_scanned: files.len(),
        files_parsed,
        took_ms: started.elapsed().as_millis() as u64,
        filter_only,
    })
}

/// Search all sessions under `root` for `query`.
#[tauri::command]
pub fn search_sessions(
    root: Option<String>,
    query: String,
    limit: Option<usize>,
    state: tauri::State<'_, SearchCache>,
) -> Result<SearchResponse, String> {
    if query.trim().is_empty() {
        return Ok(SearchResponse {
            hits: Vec::new(),
            total: 0,
            truncated: false,
            counts: HashMap::new(),
            files_scanned: 0,
            files_parsed: 0,
            took_ms: 0,
            filter_only: true,
        });
    }
    let base = resolve_root(root);
    let mut cache = state.files.lock().map_err(|e| e.to_string())?;
    search_core(&base, &query, &mut cache, limit.unwrap_or(300))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn sample_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pisv-search-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("--root-workspace--")).unwrap();
        let file = d.join("--root-workspace--/2026-01-01T00-00-00-000Z_s1.jsonl");
        let lines = vec![
            r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/root/workspace"}"#,
            r#"{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"请帮我修复数据库连接池泄漏"}],"timestamp":1}}"#,
            r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"连接池泄漏通常是因为没有释放连接"},{"type":"text","text":"我来检查一下 connection pool 的配置"},{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"grep -r connection_pool src/"}}],"provider":"anthropic","model":"claude-sonnet-4-5","timestamp":2}}"#,
            r#"{"type":"message","id":"r1","parentId":"a1","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"t1","toolName":"bash","content":[{"type":"text","text":"src/db.rs:12: connection_pool.leak()"}],"isError":false,"timestamp":3}}"#,
        ];
        let mut f = fs::File::create(&file).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        d
    }

    #[test]
    fn finds_content_across_roles() {
        let dir = sample_dir("roles");
        let mut cache = HashMap::new();
        // "pool" appears in assistant text, thinking, tool-call args and tool result.
        let r = search_core(&dir, "pool", &mut cache, 100).unwrap();
        let roles: Vec<DocRole> = r.hits.iter().map(|h| h.role).collect();
        assert!(
            roles.contains(&DocRole::Assistant),
            "assistant text hit: {roles:?}"
        );
        assert!(
            roles.contains(&DocRole::ToolResult),
            "tool result hit: {roles:?}"
        );
        assert!(
            roles.contains(&DocRole::ToolCall),
            "tool call hit: {roles:?}"
        );
        // Snippets carry the match and offsets that land inside them.
        for h in &r.hits {
            assert!(h.snippet.to_lowercase().contains("pool"));
            assert!(!h.highlights.is_empty(), "expected highlight ranges");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn searches_chinese_content() {
        let dir = sample_dir("cjk");
        let mut cache = HashMap::new();
        let r = search_core(&dir, "数据库连接池", &mut cache, 100).unwrap();
        assert!(r.total >= 1);
        assert!(r.hits.iter().any(|h| h.role == DocRole::User));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn role_filter_works() {
        let dir = sample_dir("filter");
        let mut cache = HashMap::new();
        let r = search_core(&dir, "role:thinking 连接池", &mut cache, 100).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.hits[0].role, DocRole::Thinking);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn quoted_phrase_is_exact() {
        let dir = sample_dir("phrase");
        let mut cache = HashMap::new();
        // Present verbatim in both the user message and the thinking block.
        let hit = search_core(&dir, "\"连接池泄漏\"", &mut cache, 100).unwrap();
        assert_eq!(hit.total, 2);
        // Reordered words must not match a quoted phrase.
        let miss = search_core(&dir, "\"泄漏数据库\"", &mut cache, 100).unwrap();
        assert_eq!(miss.total, 0);
        // ...but the same words unquoted (AND of terms) do match.
        let unquoted = search_core(&dir, "泄漏 数据库", &mut cache, 100).unwrap();
        assert!(unquoted.total >= 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn exclusion_filters_results() {
        let dir = sample_dir("exclude");
        let mut cache = HashMap::new();

        // Role exclusion via -role:.
        let r = search_core(&dir, "pool -role:toolResult", &mut cache, 100).unwrap();
        assert!(!r.hits.is_empty());
        assert!(
            r.hits.iter().all(|h| h.role != DocRole::ToolResult),
            "role exclusion leaked: {:?}",
            r.hits.iter().map(|h| h.role).collect::<Vec<_>>()
        );

        // Text exclusion via -term.
        let r2 = search_core(&dir, "请帮我 -泄漏", &mut cache, 100).unwrap();
        assert_eq!(r2.total, 0, "text exclusion should drop the user message");

        // Combined role filter (positive) still works alongside -role:.
        let r3 = search_core(&dir, "pool role:assistant+thinking", &mut cache, 100).unwrap();
        assert!(r3
            .hits
            .iter()
            .all(|h| matches!(h.role, DocRole::Assistant | DocRole::Thinking)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn exclusion_only_query_filters() {
        let dir = sample_dir("excl-only");
        let mut cache = HashMap::new();
        // No positive terms, only "-泄漏": should drop docs containing it.
        let r = search_core(&dir, "-泄漏", &mut cache, 100).unwrap();
        assert!(!r.filter_only, "an exclusion-only query still scans text");
        assert!(
            r.hits.iter().all(|h| !h.snippet.contains("泄漏")),
            "excluded term leaked into results"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn counts_use_frontend_role_keys() {
        let dir = sample_dir("keys");
        let mut cache = HashMap::new();
        let r = search_core(&dir, "pool", &mut cache, 100).unwrap();
        for k in r.counts.keys() {
            assert!(
                [
                    "user",
                    "assistant",
                    "thinking",
                    "toolCall",
                    "toolResult",
                    "event"
                ]
                .contains(&k.as_str()),
                "unexpected counts key: {k}"
            );
        }
        assert!(
            r.counts.contains_key("toolResult"),
            "got {:?}",
            r.counts.keys()
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn filter_only_query_lists_documents() {
        let dir = sample_dir("filteronly");
        let mut cache = HashMap::new();
        let r = search_core(&dir, "role:user", &mut cache, 100).unwrap();
        assert!(r.filter_only);
        assert_eq!(r.total, 1);
        assert_eq!(r.hits[0].role, DocRole::User);
        assert!(r.hits[0].highlights.is_empty());
        assert!(!r.hits[0].snippet.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_avoids_reparse() {
        let dir = sample_dir("cache");
        let mut cache = HashMap::new();
        let first = search_core(&dir, "connection_pool", &mut cache, 100).unwrap();
        assert_eq!(first.files_parsed, 1);
        let second = search_core(&dir, "pool", &mut cache, 100).unwrap();
        assert_eq!(second.files_parsed, 0, "second search should hit the cache");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn highlights_are_within_snippet() {
        let dir = sample_dir("hl");
        let mut cache = HashMap::new();
        let r = search_core(&dir, "connection_pool", &mut cache, 100).unwrap();
        for h in &r.hits {
            let n = h.snippet.chars().count();
            for [s, e] in &h.highlights {
                assert!(*s <= *e, "start must not exceed end");
                assert!(*e <= n, "highlight {e} exceeds snippet length {n}");
            }
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
