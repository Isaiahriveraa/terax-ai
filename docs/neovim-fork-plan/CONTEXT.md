# Terax-Neovim Fork — Glossary

## Editor Surfaces

- **EditorPane**: The primary file-editing tab. The editor where the user opens a file from the explorer, types code, etc. **Will be replaced by Neovim.**
- **AiDiffPane**: Side-by-side AI edit diff display with hunk-by-hunk accept/reject. **Stays on CodeMirror.** Not a file-editing surface.
- **GitDiffPane**: Git diff and commit file review display with staging actions. **Stays on CodeMirror.** Not a file-editing surface.

## Scope Boundary

Only `EditorPane` is in scope for Neovim replacement. The diff/display surfaces remain on CodeMirror 6 unchanged. The `EditorPaneHandle` interface abstracts the backend so `EditorStack` works with either Neovim or CodeMirror without awareness of which is active.

## File Ownership Model

**Neovim owns file I/O directly.** When Neovim mode is active:
- Neovim reads and writes files to disk directly (`nvim_command("edit {path}")`, `:w`)
- Terax's Rust `fs_read_file` / `fs_write_file` path is **bypassed** for editor-bound files
- The `useDocument` hook is not used in neovim mode (file content lives in Neovim's buffer, not in JS state)
- Dirty state comes from Neovim's `&modified`, not from a JS tracker
- AI tools (`read_file`, `write_file`, `edit`) use Terax's Rust FS layer independently — they don't need editor integration
- Save shortcut (Cmd+S) calls `nvim_command("write")` instead of `saveRef.current()`

This is a Phase 1 decision. If Phase 2 needs AI awareness of buffer state, it reads via `nvim_buf_get_lines()` RPC — it does not intercept the write path.

## Rendering Strategy

**Phase 1: DOM row spans.** Each row is a `<div>`, each color-run is a `<span>`. CSS handles fonts, colors, cursor. Debuggable in browser devtools. Swap to Canvas 2D with damage tracking + glyph caching if profiling shows DOM is too slow (unlikely at 80×24 viewport). Both implement the same `IGridSink` trait, so the swap is contained to one module.

## IPC Boundary

**Parse in Rust, forward typed events to frontend.** The Rust reader thread owns all msgpack decoding:
- Raw bytes → `rmpv` decode → demux responses vs notifications
- Responses matched by msgid against pending request map
- `"redraw"` notifications parsed into `NvimRedrawEvent` structs
- Typed events forwarded to frontend via `Channel<NvimRedrawEvent>`
- Frontend receives clean typed data, no msgpack knowledge needed

## msgpack Crate

**Raw `rmpv` + `rmp-serde`, not `nvim-rs`.** Full control over msgpack-RPC encoding/decoding. ~100 lines of glue for encode/decode. Request/response matching via `HashMap<u32, oneshot::Sender>` in a single-writer actor task. Neovim's capabilities (init.lua, plugins, LSP, Telescope, grep) come from the real Neovim process, not from our code.

## Keyboard Shortcuts

When the Neovim editor has focus, **all keys go to Neovim except a short allowlist of Terax app shortcuts:**
- `Cmd+T` — new tab
- `Cmd+Shift+[` / `Cmd+Shift+]` — switch tabs
- `Cmd+,` — settings

Everything else forwards to Neovim: `Cmd+S` (save → `:w`), `Cmd+W` (close buffer), `Cmd+F` (Neovim search), `Cmd+Z` (undo), `Ctrl+W` (window commands). The user wants Neovim — give them Neovim.

## Clipboard

**Option A: Handle in Rust via `arboard` crate.** Lua injection at startup (`vim.g.clipboard` via `vim.rpcnotify`) routes `"+` yank/paste through RPC notifications. Rust reader thread handles:
- `clipboard_copy` notification → `arboard::Clipboard::set_text()`
- `clipboard_paste` notification → `arboard::Clipboard::get_text()` → `nvim_exec_lua()` to set response

No webview involvement. No async clipboard permissions.

## Mouse

**On for Phase 1.** Send `nvim_input_mouse()` on click/drag/scroll events. Coordinate conversion: `col = (pageX - canvas.offsetX) / cellWidth`, `row = (pageY - canvas.offsetY) / cellHeight`. Add a setting to disable later if needed.

## Editor Tabs

**Option B: One shared Neovim process, multi-buffer.** All editor tabs share a single `nvim --embed` instance. Files are Neovim buffers. Tab switching calls `nvim_command("buffer {bufnr}")`. Tab-to-buffer mapping is tracked on the Rust side. One process = ~100-200MB total, not per tab. Option A (one process per tab) is redundant — Neovim is designed for multi-buffer editing.

## Dirty State Tracking

**Option A: RPC autocommand.** Inject `BufModifiedSet` autocmd via Lua at startup. Fires `vim.rpcnotify(channel, 'buf_modified_set', bufnr, modified)` on change. Rust reader thread catches it → emits `dirty_change` event to frontend. Zero polling, exact results.

## File Explorer Integration

Clicking a file in the explorer calls `nvim_open(path)` which opens it as a Neovim buffer. If already open, Neovim switches to that existing buffer (automatic via `:edit`). No separate CodeMirror tab for file editing in neovim mode.
