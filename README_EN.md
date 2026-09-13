<div align="center">

# π Pi Session Viewer

**Turn pi coding agent's JSONL session logs into a readable conversation timeline**

A native desktop app built with Tauri + React + Rust: scan a directory → parse sessions → render structure

[![Release](https://img.shields.io/github/v/release/Ray4AI/pi-session-viewer?style=flat-square)](https://github.com/Ray4AI/pi-session-viewer/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-2021-000000?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square)](#download)

<sub><a href="README.md">中文</a> · English</sub>

</div>

---

## Why?

pi records every session to JSONL files under `~/.pi/agent/sessions/` — messages, thinking, tool calls, tool output, token usage, model switches, branches, and compaction. It's all there, but **opening the file gives you a wall of JSON**.

**Pi Session Viewer** parses those files into a structured chat UI: who said what, which tool ran, what arguments it got, what it returned, and how many tokens it cost — at a glance.

![Screenshot](docs/images/screenshot.png)

---

## Features

### 📂 Session browsing
- Recursively scans any directory for `.jsonl` session files (defaults to `~/.pi/agent/sessions/`)
- Auto-groups sessions by **project directory**, with one-click filtering
- **Full-text search** across title, cwd, model, session ID, and first message
- Each row shows message count, tool calls, file size, model, and an error marker

### 💬 Structured conversation timeline
| Content | Rendering |
|---------|-----------|
| User messages | Green bubble, original line breaks preserved |
| Assistant replies | **Full Markdown** (tables, lists, quotes, links) |
| Code blocks | Syntax highlighting (highlight.js, auto-detected) |
| Thinking | Collapsible 💭 block, collapsed by default with a preview |
| Tool calls | Expandable cards: command / file path / arguments at a glance |
| Tool output | Monospace block, auto-truncated with a character-count note |
| File edits | **Red/green diff view** for `edit` oldText/newText |
| Web fetches | Output rendered as Markdown instead of raw strings |

### 📊 Usage statistics
- Per-reply token breakdown: input / output / cache read / cache write / total / cost
- Session-level totals: user turns, assistant replies, tool calls, thinking blocks, tokens, cost

### 🌳 Branches and events
- Fully parses pi's `id`/`parentId` tree, **following the latest branch by default**
- Dropdown switch between leaves when a session has multiple branches
- Model changes, thinking level, renames, compaction, and branch summaries appear as timeline events
- Hidden extension messages (`display: false`) are skipped

### 🔒 Privacy
- **Fully local**: parsing happens in the Rust backend in memory — no network, no uploads
- **Read-only**: session files are never modified
- Size and token limits protect the UI from enormous outputs

---

## Download

Get the latest installer from [Releases](https://github.com/Ray4AI/pi-session-viewer/releases):

| Platform | File |
|----------|------|
| **Windows 10/11 x64** | `Pi-Session-Viewer_x.y.z_x64-setup.exe` (recommended) or `.msi` |
| macOS (Apple Silicon) | `Pi.Session.Viewer_x.y.z_aarch64.dmg` |
| Linux x64 | `.AppImage` or `.deb` |

> Windows users can just run `setup.exe` — no runtime prerequisites (Tauri uses the system WebView2).

---

## Usage

1. Launch the app; it auto-scans `~/.pi/agent/sessions/`
2. Click a session on the left to see the structured conversation on the right
3. Use **Change** to point at another directory (e.g. an archived backup)
4. Click a tool card header to expand its arguments and output
5. Click 💭 to expand the full reasoning

**Custom session directory**: set the `PI_SESSIONS_DIR` environment variable to override the default path.

---

## Build from source

### Prerequisites
- [Node.js](https://nodejs.org/) ≥ 18
- [Rust](https://rustup.rs/) ≥ 1.77
- Platform deps: see [Tauri prerequisites](https://tauri.app/start/prerequisites/)
  - Linux: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `patchelf`

### Develop

```bash
npm install
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

Artifacts land in `src-tauri/target/release/bundle/`.

### Cross-compile the Windows installer from Linux

Requires `mingw-w64` and `nsis` (`sudo apt-get install mingw-w64 nsis`):

```bash
rustup target add x86_64-pc-windows-gnu
npm run tauri build --target x86_64-pc-windows-gnu
```

Output: `src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/*-setup.exe`.
Tauri treats cross-compilation as experimental; official releases build natively
on `windows-latest` through the [release workflow](.github/workflows/release.yml).

### Test

```bash
npm run test                                            # frontend: branch logic, render model, formatters
cargo test --manifest-path src-tauri/Cargo.toml --lib   # backend: JSONL parsing, scanning, grouping
```

---

## Architecture

```
pi-session-viewer/
├── src/                        # React frontend
│   ├── types.ts                # Types mirroring the Rust structs
│   ├── sessionModel.ts         # Branch rebuild / render model / stats (+ tests)
│   ├── api.ts                  # Tauri invoke wrappers
│   ├── App.tsx                 # Layout, session header, event rows
│   └── components/
│       ├── Sidebar.tsx         # Project groups, search, session list
│       ├── MessageView.tsx     # User / assistant / tool result / thinking
│       ├── ToolCallView.tsx    # Tool cards, arguments, diffs, output
│       └── Markdown.tsx        # Markdown + syntax highlighting
└── src-tauri/                  # Rust backend
    ├── src/session.rs          # JSONL parsing, scanning, project grouping (+ tests)
    └── src/lib.rs              # Tauri command registration
```

**Design principle**: Rust does fast scanning and tolerant parsing; the frontend receives structured JSON and focuses on rendering. Branch reconstruction in `sessionModel.ts` and the Rust parser are tested independently.

### Supported format

Full support for [pi session format v1/v2/v3](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/session-format.md):

- Entry types: `session`, `message`, `model_change`, `thinking_level_change`, `compaction`, `branch_summary`, `custom`, `custom_message`, `session_info`, `label`
- Message roles: `user`, `assistant`, `toolResult`, `custom`, `branchSummary`, `compactionSummary`
- Content blocks: `text`, `thinking`, `toolCall`, `image`

Corrupt lines are tolerated: unparseable lines are skipped and flagged without breaking the whole session.

---

## License

[MIT](LICENSE)

---

<div align="center">

**If this tool helps you, consider giving it a ⭐**

</div>
