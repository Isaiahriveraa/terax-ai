# Phase 1 Deep-Dive: Neovim msgpack-RPC Bridge for Terax Fork

> **Goal**: Replace the CodeMirror 6 editor (with `@replit/codemirror-vim` JS emulation) with a real Neovim instance via `nvim --embed` and msgpack-RPC. This document covers Phase 1: the Rust-side process bridge and frontend renderer prototype.

---

## 1. Fork Strategy

### Initial Setup

```bash
# Clone upstream
git clone git@github.com:crynta/terax-ai.git terax-nvim
cd terax-nvim

# Add upstream remote
git remote add upstream git@github.com:crynta/terax-ai.git

# Create the feature branch
git checkout -b nvim-editor

# Protect main - it will track upstream for cherry-picks
git branch main origin/main --track
```

### Branch Layout

```
main          → tracks upstream/main. Only merge from upstream.
nvim-editor   → our neovim replacement work. Rebase on main.
feat/phase1   → Phase 1 work branch (merge into nvim-editor)
feat/phase2   → Phase 2 work branch
```

### Upstream Sync Flow

```bash
git checkout main
git pull upstream main
git checkout nvim-editor
git rebase main
```

**Conflict expectation**: Low-to-medium. The editor module (`src/modules/editor/`) is self-contained. Conflicts will only happen if upstream changes `EditorPane.tsx`, `EditorStack.tsx`, or the tab system's editor tab kind. The terminal, AI, git, explorer, and theme modules will not conflict.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Tauri Webview                              │
│                                                                  │
│  ┌────────────────────────┐    ┌────────────────────────────┐   │
│  │     Terminal Tab        │    │     Editor Tab (NEW!)      │   │
│  │  (xterm.js + PTY -      │    │                            │   │
│  │   unchanged)            │    │  NeovimGrid.tsx            │   │
│  │                         │    │  ┌──────────────────┐     │   │
│  │  nvim works here        │    │  │  Canvas/DOM Grid  │     │   │
│  │  already via shell      │    │  │  Renderer         │     │   │
│  └────────────────────────┘    │  │  ← redraw events  │     │   │
│                                 │  │  → keystrokes     │     │   │
│                                 │  └──────────────────┘     │   │
│                                 └───────────┬────────────────┘   │
│                                             │                     │
│  ┌──────────────────────────────────────────┴────────────────┐   │
│  │              Tauri IPC Layer                                │   │
│  │  invoke("nvim_open", {file})                               │   │
│  │  invoke("nvim_input", {keys})                              │   │
│  │  invoke("nvim_resize", {cols, rows})                       │   │
│  │  Channel<NvimEvent> → redraw events streamed to frontend  │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
                          │ Tauri IPC
┌─────────────────────────┼─────────────────────────────────────────┐
│  Rust Backend            │                                         │
│                          ▼                                         │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │              modules/nvim/ (NEW)                             │   │
│  │                                                              │   │
│  │  mod.rs       → Tauri command handlers + NvimState           │   │
│  │  session.rs   → spawn nvim --embed, manage lifecycle         │   │
│  │  rpc.rs       → msgpack-RPC encode/decode                    │   │
│  │  ui_events.rs → parse grid_* events from neovim             │   │
│  │  │                                                              │   │   │
│  │  │  ┌──────────────────────────────────────────────────────┐   │   │   │
│  │  │  │  nvim --embed (child process)                        │   │   │   │
│  │  │  │  - stdin/stdout → msgpack-RPC                         │   │   │   │
│  │  │  │  - Loads ~/.config/nvim/init.lua                      │   │   │   │
│  │  │  │  - **Owns file I/O**: reads/writes files to disk      │   │   │   │
│  │  │  │  - All plugins work (LSP, telescope, treesitter)      │   │   │   │
│  │  │  └──────────────────────────────────────────────────────┘   │   │   │
│  │  │                                                              │   │   │
│  │  │  Note: Neovim reads/writes files directly.                 │   │   │
│  │  │  Terax's fs_read_file / fs_write_file is bypassed.         │   │   │
│  │  │  AI tools use Rust FS independently — no conflict.         │   │   │
└──────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Transport | stdin/stdout (not socket) | Simpler process mgmt, startup pause works, no port conflicts |
| msgpack crate | **Raw `rmpv` + `rmp-serde`** | Skip nvim-rs — it doesn't expose raw redraw notifications cleanly. We need full control over msgpack frame parsing. ~100 lines of glue. |
| Process type | `tokio::process::Command` | Single-writer actor queue to stdin prevents interleaved frames |
| UI event protocol | `ext_linegrid` only (no multigrid) | Splits/floats drawn into main grid by neovim itself; enable multigrid later |
| Frontend renderer | **DOM row spans** (not Canvas) | Easier debug via browser devtools; swap to Canvas later if needed |
| Editor tab mode | Hybrid toggle | Keep CodeMirror available as option (settings toggle) |
| Startup flags | `nvim --embed` (NO `--headless`) | neovim pauses startup so embedder can attach |
| File ownership | **Neovim owns file I/O** | nvim reads/writes disk directly. `useDocument` hook bypassed. Save calls `nvim_command("write")`. |
| IPC boundary | **Parse in Rust, forward typed events** | Rust reader thread owns all msgpack decoding. Frontend receives typed `NvimRedrawEvent` structs via Channel. No msgpack knowledge on frontend. |
---

## 3. File-by-File Breakdown

### 3.1 New Rust Files

#### `src-tauri/src/modules/nvim/mod.rs` — Tauri Command Surface

One shared Neovim instance. All editor tabs are buffers in that instance.
Tab switching calls `nvim_command("buffer {bufnr}")`.

```rust
// Public API exposed to frontend via invoke():

#[tauri::command]
/// Open a file as a buffer in the shared Neovim instance.
/// Returns the buffer number for tab tracking.
async fn nvim_open(
    state: tauri::State<'_, NvimState>,
    path: String,
) -> Result<u32, String>  // returns bufnr

#[tauri::command]
/// Switch to a specific buffer by number.
async fn nvim_switch_buffer(
    state: tauri::State<'_, NvimState>,
    bufnr: u32,
) -> Result<(), String>

#[tauri::command]
/// Send keystrokes to the shared Neovim instance.
async fn nvim_input(
    state: tauri::State<'_, NvimState>,
    keys: String,
) -> Result<(), String>

#[tauri::command]
/// Resize the Neovim grid.
async fn nvim_resize(
    state: tauri::State<'_, NvimState>,
    cols: u16,
    rows: u16,
) -> Result<(), String>

#[tauri::command]
/// Close a buffer (or quit if last).
async fn nvim_close(
    state: tauri::State<'_, NvimState>,
    bufnr: u32,
) -> Result<(), String>

#[tauri::command]
/// Generic Neovim API call (used sparingly).
async fn nvim_exec(
    state: tauri::State<'_, NvimState>,
    method: String,
    args: Vec<rmpv::Value>,
) -> Result<rmpv::Value, String>

// State: single shared Neovim session
pub struct NvimState {
    session: RwLock<Option<Arc<NvimSession>>>
}

// The redraw channel is registered by the active editor tab on mount.
// Neovim renders the current (active) buffer into whatever tab is visible.
```

**Note on tab lifecycle**: The Neovim process is lazy-started on first `nvim_open` and
shuts down when the last editor tab closes. Tab switch = `nvim_switch_buffer(bufnr)`.

#### `src-tauri/src/modules/nvim/session.rs` — Neovim Process Lifecycle

```rust
pub struct NvimSession {
    pub child: Arc<Mutex<Child>>,
    pub stdin: Arc<Mutex<ChildStdin>>,
    pub redraw_tx: mpsc::Sender<NvimRedrawEvent>,
    pub exit_tx: mpsc::Sender<i32>,
    // Thread handles
    reader_handle: Option<thread::JoinHandle<()>>,
    request_id: AtomicU32,
}

impl NvimSession {
    /// Spawn `nvim --embed`, negotiate protocol, return session
    pub fn spawn(
        id: u32,
        path: String,
        on_redraw: Channel<NvimRedrawEvent>,
        on_exit: Channel<i32>,
        user_config: NvimConfig,
    ) -> Result<Arc<Self>, String> { ... }

    /// Send keystrokes to neovim via msgpack-RPC
    pub fn input(&self, keys: &str) -> Result<(), String> { ... }

    /// Resize the neovim grid
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> { ... }

    /// Call any neovim API method
    pub fn call(&self, method: &str, args: Vec<rmpv::Value>) -> Result<rmpv::Value, String> { ... }

    /// Clean shutdown
    pub fn close(&self) { ... }
}
```

**Spawn sequence** (called once, on first `nvim_open`):
1. Build `Command` for `nvim --embed` (NO `--headless`)
2. Set `TERM=xterm-256color` and `COLORTERM=truecolor`
3. Spawn process, capture stdin/stdout+stderr
4. Drain stderr in background thread (prevents deadlock)
5. Send initial handshake: `nvim_get_api_info()` → validate API
6. Attach as UI: `nvim_ui_attach(cols, rows, {ext_linegrid, rgb})`
7. Inject `vim.g.clipboard` Lua config for clipboard bridging
8. Return session — subsequent `nvim_open()` calls just open buffers

#### `src-tauri/src/modules/nvim/rpc.rs` — msgpack-RPC Protocol

```rust
// msgpack-RPC message types
pub enum RpcMessage {
    Request {
        msgid: u32,
        method: String,
        params: Vec<rmpv::Value>,
    },
    Response {
        msgid: u32,
        error: Option<rmpv::Value>,
        result: Option<rmpv::Value>,
    },
    Notification {
        method: String,
        params: Vec<rmpv::Value>,
    },
}

// Encode a request: [0, msgid, "method", [params]]
pub fn encode_request(msgid: u32, method: &str, params: Vec<rmpv::Value>) -> Vec<u8> { ... }

// Decode any msgpack-RPC message from a byte stream
pub fn decode_message(bytes: &[u8]) -> Result<(RpcMessage, usize), String> { ... }

// High-level API call: send request, block for matching response
pub fn rpc_call(
    stdin: &mut ChildStdin,
    stdout: &mut ChildStdout,
    method: &str,
    params: Vec<rmpv::Value>,
) -> Result<rmpv::Value, String> { ... }

// Notification (fire-and-forget): [2, "method", [params]]
pub fn encode_notification(method: &str, params: Vec<rmpv::Value>) -> Vec<u8> { ... }

// Serialization helpers for neovim's wire format
pub mod types {
    // Neovim uses arrays for API calls: [0, msgid, "method", [...args]]
    // UI events arrive as notifications: [2, "redraw", [...ext_data]]
    pub fn parse_ext_linegrid(data: &[rmpv::Value]) -> Vec<GridEvent> { ... }
}
```

**msgpack-RPC wire format**:

Neovim uses standard msgpack-RPC:
```
Request:     [0, msgid, "method_name", [arg1, arg2, ...]]
Response:    [1, msgid, error, result]
Notification: [2, "method_name", [arg1, arg2, ...]]
```

UI events arrive as notifications with method `"redraw"` and params containing an array of ext_* event arrays:
```json
[2, "redraw", [
  ["ext_linegrid", [
    {"grid": 1, "row": 0, "col_start": 0, "cells": [[...], ...]},
    ...
  ]],
  ["grid_cursor_goto", {"grid": 1, "row": 5, "col": 10}],
  ["flush", []]
]]
```

#### `src-tauri/src/modules/nvim/ui_events.rs` — Event Parser

```rust
#[derive(Debug, Clone, Serialize)]
pub struct NvimRedrawEvent {
    pub event_type: RedrawEventType,
    pub payload: RedrawPayload,
}

#[derive(Debug, Clone, Serialize)]
pub enum RedrawEventType {
    GridResize,
    GridLine,
    GridClear,
    GridCursorGoto,
    GridScroll,
    Flush,
    ModeChange,
    SetTitle,
    OptionSet,
    DefaultColorsSet,
    MouseOn,
    MouseOff,
}

#[derive(Debug, Clone, Serialize)]
pub enum RedrawPayload {
    GridResize { grid: u32, width: u64, height: u64 },
    GridLine { grid: u32, row: u64, col_start: u64, cells: Vec<CellData> },
    GridCursorGoto { grid: u32, row: u64, col: u64 },
    GridScroll { grid: u32, top: u64, bottom: u64, left: u64, right: u64, rows: i64 },
    ModeChange { mode: String },
    DefaultColors { fg: u32, bg: u32, sp: u32 },
    // ...
}

#[derive(Debug, Clone, Serialize)]
pub struct CellData {
    pub char: String,
    pub double_width: bool,
    pub highlight: CellHighlight,
}

#[derive(Debug, Clone, Serialize)]
pub struct CellHighlight {
    pub foreground: Option<[u8; 3]>,
    pub background: Option<[u8; 3]>,
    pub special: Option<[u8; 3]>,
    pub reverse: bool,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub undercurl: bool,
}

/// Parse the ext_linegrid event array from neovim
pub fn parse_redraw_notification(params: &[rmpv::Value]) -> Vec<NvimRedrawEvent> { ... }
```

### 3.2 Modified Rust Files

#### `src-tauri/src/modules/mod.rs` — Register New Module

```diff
 pub mod agent;
 pub mod fs;
 pub mod git;
 pub mod net;
+pub mod nvim;
 pub mod proc;
 pub mod pty;
 pub mod secrets;
 pub mod shell;
 pub mod workspace;
```

#### `src-tauri/src/lib.rs` — Register Commands & State

```diff
-use modules::{agent, fs, git, net, pty, secrets, shell, workspace};
+use modules::{agent, fs, git, net, nvim, pty, secrets, shell, workspace};

 // In run():
 .manage(pty::PtyState::default())
+.manage(nvim::NvimState::default())
 .manage(shell::ShellState::default())
 // ...

 .invoke_handler(tauri::generate_handler![
     pty::pty_open,
     // ...
+    nvim::nvim_open,
+    nvim::nvim_input,
+    nvim::nvim_resize,
+    nvim::nvim_close,
+    nvim::nvim_exec,
     // ...
 ])
```

#### `src-tauri/Cargo.toml` — Add Dependencies

```toml
[dependencies]
# ... existing ...
+rmp-serde = "1"           # msgpack serialization
+rmpv = "1"                # msgpack value type (for dynamic neovim types)
+tokio = { version = "1", features = ["rt", "process", "io-util"] }
```

Note: `tokio` is already a dependency. The `process` and `io-util` features may need to be added.

### 3.3 New Frontend Files

#### `src/modules/nvim/` — New Frontend Module

**`src/modules/nvim/NeovimEditor.tsx`** — Main React component (replaces EditorPane in "neovim mode"):

```tsx
// Props: path, onDirtyChange, onSaved, onClose
// Creates a canvas element, handles keyboard input, receives redraw events

interface NeovimEditorHandle {
  focus: () => void;
  getSelection: () => string | null;
  getPath: () => string;
  reload: () => boolean;
  undo: () => void;
  redo: () => void;
  setQuery: (q: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearQuery: () => void;
}
```
**Key responsibilities** (shared Neovim session — one process, multi-buffer):
1. On mount, register this component's `on_redraw` channel with the shared session
2. Call `invoke("nvim_open", { path })` → opens file as buffer, returns bufnr
3. Create a DOM grid element (row spans) sized to available space
4. Listen on the shared `on_redraw` channel → paint grid updates to DOM
5. Listen for keyboard events → `invoke("nvim_input", { keys })`
6. Handle resize → `invoke("nvim_resize", { cols, rows })`
7. Handle tab switch → `invoke("nvim_switch_buffer", { bufnr })`
8. Cmd+S → `invoke("nvim_input", { keys: "<Esc>:w<CR>" })` — Neovim writes to disk directly
9. On unmount (tab close) → `invoke("nvim_close", { bufnr })` — closes buffer, keeps nvim running

**Note on file ownership**: Neovim owns file I/O. The `useDocument` hook is NOT used.
Dirty state is tracked via Neovim's `&modified`. Save goes through `nvim_command("write")`.
See CONTEXT.md: File Ownership Model for details.
**`src/modules/nvim/lib/neovimGrid.ts`** — Canvas renderer:

```ts
// Neovim grid renderer — paints cell data to HTML5 Canvas

export class NeovimGridRenderer {
  private ctx: CanvasRenderingContext2D;
  private cellWidth: number;
  private cellHeight: number;
  private cols: number;
  private rows: number;
  private grid: Cell[][];
  private cursorRow: number;
  private cursorCol: number;
  private defaultFg: [number, number, number];
  private defaultBg: [number, number, number];
  
  constructor(canvas: HTMLCanvasElement);
  
  handleEvent(event: NvimRedrawEvent): void;
  
  render(): void;
  
  resize(cols: number, rows: number): void;
  
  // Font measurement helpers
  private measureCell(): { width: number; height: number };
  private drawCell(col: number, row: number, cell: Cell): void;
  private drawCursor(): void;
}
```

**`src/modules/nvim/lib/types.ts`** — Shared types:

```ts
export enum RedrawEventType {
  GridResize = "grid_resize",
  GridLine = "grid_line",
  GridClear = "grid_clear",
  GridCursorGoto = "grid_cursor_goto",
  GridScroll = "grid_scroll",
  Flush = "flush",
  ModeChange = "mode_change",
  SetTitle = "set_title",
  OptionSet = "option_set",
  DefaultColorsSet = "default_colors_set",
  MouseOn = "mouse_on",
  MouseOff = "mouse_off",
}

export interface NvimRedrawEvent {
  event_type: RedrawEventType;
  payload: any; // discriminated union
}

export interface Cell {
  char: string;
  doubleWidth: boolean;
  highlight: CellHighlight;
}

export interface CellHighlight {
  foreground?: [number, number, number];
  background?: [number, number, number];
  special?: [number, number, number];
  reverse: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  undercurl: boolean;
}
```

**`src/modules/nvim/index.ts`** — Barrel export:

```ts
export { NeovimEditor } from "./NeovimEditor";
export type { NeovimEditorHandle } from "./NeovimEditor";
```

### 3.4 Modified Frontend Files

#### `src/modules/editor/EditorPane.tsx` — Add Neovim Toggle

```diff
import { usePreferencesStore } from "@/modules/settings/preferences";
import { NeovimEditor } from "@/modules/nvim";

 // In the component:
const neovimMode = usePreferencesStore((s) => s.neovimMode);

if (neovimMode) {
  // Neovim owns file I/O directly — file is read/written by nvim process
  // No useDocument hook, no fs_write_file. Dirty state from &modified.
  return <NeovimEditor path={path} onDirtyChange={onDirtyChange} onSaved={onSaved} onClose={onClose} />;
}
 // ... existing CodeMirror code unchanged ...
```

**Design**: When `neovimMode` is enabled, render `NeovimEditor` instead of `CodeMirror`. The two modes share the same `EditorPaneHandle` interface, so `EditorStack` works unchanged. The `vimMode` preference from settings (`@replit/codemirror-vim`) becomes irrelevant when `neovimMode` is on.

#### `src/modules/settings/store.ts` — Add neovimMode Preference

```diff
 export interface PreferencesState {
   // ...
   vimMode: boolean;
+  neovimMode: boolean;
   // ...
 }
```

#### `src/modules/settings/components/EditorSettings.tsx` — Add Toggle UI

Add a "Use Neovim" toggle to the editor settings panel that toggles the `neovimMode` preference.

---

## 4. msgpack-RPC Protocol Details

### 4.1 Spawn Sequence

```
Frontend                     Rust Backend                     Neovim Process
   │                             │                                  │
   │ invoke("nvim_open")         │                                  │
   │────────────────────────────>│                                  │
   │                             │ Command::new("nvim")             │
   │                             │   .arg("--embed")                │
   │                             │   (NO --headless — nvim pauses  │
   │                             │    startup so embedder can attach)│
   │                             │   .env("TERM", "xterm-256color") │
   │                             │   .env("COLORTERM", "truecolor") │
   │                             │   .stdin(Stdio::piped())         │
   │                             │   .stdout(Stdio::piped())        │
   │                             │   .stderr(Stdio::piped())        │
   │                             │   (stderr MUST be drained —      │
   │                             │    a full pipe deadlocks nvim)    │
   │                             │──────── spawn ──────────────────>│
   │                             │ RPC request:                     │
   │                             │ nvim_ui_attach(80, 24, {         │
   │                             │   rgb: true,                     │
   │                             │   ext_linegrid: true,            │
   │                             │   ext_multigrid: false,          │
   │                             │   ext_popupmenu: false,          │
   │                             │   ext_tabline: false,            │
   │                             │   ext_cmdline: false,            │
   │                             │   ext_wildmenu: false,           │
   │                             │   ext_messages: false,           │
   │                             │ })                               │
   │                             │─────────────────────────────────>│
   │                             │                                  │
   │                             │ RPC request:                     │
   │                             │ nvim_set_option("guifont",       │
   │                             │   "JetBrainsMono NF:h13")        │
   │                             │─────────────────────────────────>│
   │                             │                                  │
   │                             │ RPC request:                     │
   │                             │ nvim_command("edit path")        │
   │                             │─────────────────────────────────>│
   │                             │                                  │
   │     id, Channel<NvimEvent>  │      UI events start flowing     │
   │<────────────────────────────│<─────────────────────────────────│
```

### 4.2 Critical UI Events to Handle

| Event | Purpose | Payload |
|-------|---------|---------|
| `grid_resize` | Grid dimensions changed | `{grid, width, height}` |
| `grid_line` | A line of text to draw | `{grid, row, col_start, cells: [{char, highlight_id, repeat}]}` |
| `grid_cursor_goto` | Cursor moved | `{grid, row, col}` |
| `grid_scroll` | Scroll region | `{grid, top, bottom, left, right, rows}` |
| `grid_clear` | Clear entire grid | `{grid}` |
| `flush` | **Draw everything buffered so far** | `[]` |
| `mode_change` | Mode changed (normal/insert/visual) | `{mode}` |
| `default_colors_set` | Default fg/bg colors | `{fg, bg, sp, cterm_fg, cterm_bg}` |
| `set_title` | Tab/window title | `{title}` |
| `option_set` | Option value changed | `{name, value}` |

**The `flush` event is critical** — neovim batches all grid updates and sends them followed by a `flush`. The frontend should accumulate all events until `flush` arrives, then render everything at once.

### 4.3 Event Pipeline in the Reader Thread

```
neovim stdout
      │
      ▼
Reader thread reads raw msgpack bytes
      │
      ▼
rpc::decode_message() → RpcMessage::Notification("redraw", [...])
      │
      ▼
Split into individual UI events:
  - [grid_resize, grid_line, ...]
      │
      ▼
ui_events::parse_redraw_notification() → Vec<NvimRedrawEvent>
      │
      ▼
Serialize to JSON → Channel<NvimEvent> → frontend
```

### 4.4 Batched Rendering Strategy

```ts
// Frontend event buffer
let pendingEvents: NvimRedrawEvent[] = [];

function onRedrawEvent(event: NvimRedrawEvent) {
  if (event.event_type === "flush") {
    // Process all buffered events and render
    renderer.render(pendingEvents);
    pendingEvents = [];
  } else {
    pendingEvents.push(event);
  }
}
```

---

## 5. Input Handling

### 5.1 Keyboard Event Translation
### 5.1 Keyboard Input Architecture

**Rule**: When the Neovim editor has focus, ALL keys go to Neovim except a short allowlist:
- `Cmd+T` — new Terax tab
- `Cmd+Shift+[` / `Cmd+Shift+]` — switch Terax tabs
- `Cmd+,` — Terax settings

Everything else is forwarded to Neovim — including `Cmd+S` (→ `:w`), `Cmd+W` (→ Neovim buffer close),
`Cmd+F` (→ `/` search), `Cmd+Z` (→ undo), `Ctrl+W` (→ window commands).
The user opted into Neovim — they get Neovim's full keybinding model.

### 5.2 Key Translation Table

When forwarding to Neovim, browser `KeyboardEvent` keys are translated to Neovim's wire format:

| Key | Neovim Input |
|-----|-------------|
| `a` | `"a"` |
| `Enter` | `"<CR>"` |
| `Tab` | `"<Tab>"` |
| `Escape` | `"<Esc>"` |
| `Backspace` | `"<BS>"` |
| `Ctrl+A` | `"<C-A>"` |
| `Alt+A` | `"<M-A>"` |
| `Shift+Tab` | `"<S-Tab>"` |
| `Delete` | `"<Del>"` |
| `Home` | `"<Home>"` |
| `End` | `"<End>"` |
| `PageUp` | `"<PageUp>"` |
| `PageDown` | `"<PageDown>"` |
| `Up` | `"<Up>"` |
| `Down` | `"<Down>"` |
| `Left` | `"<Left>"` |
| `Right` | `"<Right>"` |
| `Cmd+S` | `"<Esc>:w<CR>"` |
| `Cmd+Z` | `"<Esc>:undo<CR>"` |
| `Cmd+Shift+Z` | `"<Esc>:redo<CR>"` |
### 5.2 Input Send Method

```rust
pub fn input(&self, keys: &str) -> Result<(), String> {
    // Call nvim_input via msgpack-RPC
    // nvim_input takes a string of keys and returns nothing
    let params = vec![rmpv::Value::String(keys.into())];
    self.rpc_call("nvim_input", params)?;
    Ok(())
}
```

---

## 6. Canvas Rendering (Frontend)

### 6.1 Font and Cell Metrics

- Use the same monospace font as Terax's theme (JetBrains Mono, Fira Code, etc.)
- Measure cell dimensions on first render:
  ```ts
  ctx.font = "13px JetBrainsMono";
  const metrics = ctx.measureText("W"); // widest char
  this.cellWidth = metrics.width;
  this.cellHeight = 13 * 1.55; // line-height
  ```
- Total canvas size: `cols * cellWidth x rows * cellHeight`

### 6.2 Color Handling

- Default fg/bg come from `default_colors_set` event
- Override with Terax's theme colors for better aesthetic integration
- Use canvas fillStyle with `rgba(r, g, b, a)` format

### 6.3 Cursor Rendering

| Mode | Cursor Shape | Style |
|------|-------------|-------|
| Normal | Block | Semi-transparent fg color, outline |
| Insert | Bar (vertical line) | 2px wide, fg color |
| Visual | Block | Selected text bg color |
| Command-line | Bar | Same as insert |
| Replace | Underscore | Horizontal line |

### 6.4 Selection Rendering

Neovim sends selection info via ext_linegrid highlights. When the user uses visual mode, neovim highlights the selected area, and the renderer draws that highlight.

For mouse-based selection in the webview (outside neovim's model), implement a separate canvas overlay for browser-native text selection.

---

## 7. Dependencies

### Rust (add to Cargo.toml)

```toml
rmp-serde = "1"       # msgpack binary format
rmpv = "1"            # msgpack Value type (dynamic rpc)
```

`rmp-serde` handles the binary msgpack encoding/decoding. `rmpv` provides the `Value` enum for dynamic message structures (neovim's API calls have varying argument types).

### Frontend (no new npm dependencies)

The frontend renderer uses only the HTML5 Canvas API — no additional npm packages needed. Canvas is universally available, performant, and zero-dependency.

---

## 8. Testing Strategy

### Rust Unit Tests

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_request_standard_format() {
        let bytes = rpc::encode_request(1, "nvim_eval", vec![rmpv::Value::String("1+1".into())]);
        // [0, 1, "nvim_eval", ["1+1"]]
        assert_eq!(bytes, [0x94, 0x00, 0x01, ...]);
    }

    #[test]
    fn parse_grid_line_single_cell() {
        let data = rmpv::Value::Array(vec![
            rmpv::Value::String("ext_linegrid".into()),
            rmpv::Value::Array(vec![/* ... */]),
        ]);
        let events = ui_events::parse_redraw_notification(&data);
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn parse_multiple_ui_events_in_one_notification() {
        // Test that a single "redraw" notification with multiple
        // event arrays is parsed correctly
    }

    #[test]
    fn session_spawn_negotiates_protocol() {
        // Integration test with actual nvim binary
        // Requires nvim to be installed
    }

    #[test]
    fn rpc_call_roundtrip() {
        // Send nvim_eval("1+1") → expect result 2
        // Requires nvim to be installed
    }
}
```

### Integration Testing

- **Manual test**: Run the Tauri app, toggle neovim mode, open a file → see neovim render in the editor tab
- **Neovim version compatibility**: Test with neovim >= 0.9.0 (msgpack-RPC protocol is stable)
- **Cross-platform**: macOS (primary), Linux, Windows

---

## 9. Edge Cases & Gotchas

### 9.1 Process Lifecycle
- If neovim crashes: detect via `child.try_wait()`, clean up session, notify frontend
- If neovim exits cleanly (`:q`): catches exit notification, clean up
- If the frontend tab is closed: `nvim_close` sends `:qa!` equivalent and kills process
- On app shutdown: kill all neovim processes in `NvimState::drop`

### 9.2 Large Files
- Neovim handles large files natively (unlike CodeMirror which loaded the entire file into JS)
- This is actually an advantage — neovim's built-in file handling is more robust

### 9.3 Rapid Input
- Input can be batched: coalesce keystrokes within a frame and send as one `nvim_input` call
- Use a 16ms debounce on the frontend before sending batched input

### 9.4 File Modification Detection
- Neovim watches files for external changes (`:checktime`)
- The frontend should also watch for external file changes and trigger neovim's check

### 9.5 `$TERM` Environment
- Set `TERM=xterm-256color` for true color support
- Set `COLORTERM=truecolor` explicitly
- This ensures neovim uses the right color capabilities

### 9.6 User Config Path
- By default, neovim loads `~/.config/nvim/init.lua`
- If the user has a custom `$NVIM_APPNAME`, respect it
- Allow specifying a custom config path in settings

### 9.7 Ctrl+W Conflict
- Browser/webview intercepts `Cmd+W` / `Ctrl+W` as "close tab"
- Map `Ctrl+W` in normal mode to `nvim_feedkeys("<C-W>")` to bypass this
- Or remap the browser shortcut when neovim has focus

### 9.8 IME (Input Method Editor)
- For CJK input, ensure `compositionstart`/`compositionend` events are forwarded correctly
- Neovim handles IME natively, we just need to pass the composed text

### 9.9 Clipboard
- Neovim's clipboard (`"+" register) won't work in `--embed` mode by default
- Solution: implement a custom clipboard provider via RPC
  - Intercept `"*y` / `"+y` operations
  - Call `nui_clipboard_get()` / `nui_clipboard_set()` custom handlers
  - Or use the OSC 52 escape sequence approach

---

## 10. Phase 1 Deliverables

| # | Deliverable | Files | Done When |
|---|-----------|-------|-----------|
| 1 | Fork repo + branch setup | Git config | `main` tracks upstream, `nvim-editor` branch exists |
| 2 | Rust nvim module scaffold | `src-tauri/src/modules/nvim/{mod,session,rpc,ui_events}.rs` | Compiles, registers commands |
| 3 | nvim spawn + attach | `session.rs`, `rpc.rs` | Neovim process spawns, `nvim_ui_attach` succeeds |
| 4 | Grid event parsing | `ui_events.rs` | Grid lines, cursor, flush events parsed correctly |
| 5 | Canvas grid renderer | `src/modules/nvim/lib/neovimGrid.ts` | Neovim content renders on canvas |
| 6 | Input forwarding | `session.rs` + `NeovimEditor.tsx` | Keystrokes reach neovim, cursor moves |
| 7 | Editor tab integration | `EditorPane.tsx` | Files open in neovim via editor tab |
| 8 | Settings toggle | `store.ts` + settings UI | Toggle between CodeMirror and neovim mode |
| 9 | Tests + cleanup | Test files | Edge cases handled, clean shutdown works |

---

## 11. What Phase 2 Would Be

Phase 2 would cover AI integration — rebuilding Terax's AI edit diff and inline autocomplete on top of neovim's RPC API instead of CodeMirror's. This is deferred because:

- The AI features are deeply coupled to CodeMirror's extension API (autocomplete, selections, change events)
- Neovim has different primitives (`nvim_buf_set_lines`, `nvim_execute_lua`, `nvim_set_keymap`)
- The diff review UI would need a separate renderer (not neovim's grid — it's a side-by-side view)
- This alone could double or triple the implementation effort

Decision: ship Phase 1 with neovim for manual editing, keep AI features working in terminal/AI panel without deep editor integration. Decide on Phase 2 after Phase 1 is stable.

---

## 12. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| msgpack protocol changes in neovim | Low | High | Pin neovim version requirement (>= 0.9), follow neovim API deprecations |
| Canvas rendering performance | Low | Medium | Use `requestAnimationFrame` loop, only redraw on `flush` events, batch paint operations |
| Cross-platform process management | Medium | High | Test on macOS/Linux/Windows early, handle Windows `CreateProcess` quirks |
| User config incompatibility | Low | Medium | Fall back to `nvim --clean` if user config causes crash |
| Large file rendering in canvas | Medium | Low | Cap visible rows at viewport height, neovim handles scrollback internally |
| Keyboard shortcut conflicts | Medium | Medium | Map browser/webview shortcuts carefully, use `preventDefault` where needed |
| Upstream Terax changes break integration | Low | Medium | Keep `nvim-editor` branch rebased on upstream main, modular design isolates editor changes |
