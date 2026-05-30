import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { NeovimGridRenderer } from "./lib/neovimGrid";
import type { NeovimEditorHandle, NvimEvent } from "./lib/types";

interface Props {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  onClose?: () => void;
}

export const NeovimEditor = forwardRef<NeovimEditorHandle, Props>(
function NeovimEditor({ path, onDirtyChange, onSaved, onClose }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<NeovimGridRenderer | null>(null);
    const bufnrRef = useRef<number>(0);
    const pathRef = useRef(path);
    pathRef.current = path;
    const onDirtyChangeRef = useRef(onDirtyChange);
    onDirtyChangeRef.current = onDirtyChange;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const renderer = new NeovimGridRenderer(container);
      rendererRef.current = renderer;

      let alive = true;

      async function init() {
        const cols = Math.max(40, Math.floor(container!.clientWidth / 8));
        const rows = Math.max(10, Math.floor(container!.clientHeight / 20));

        // Create channels for receiving events from Rust backend
        const redrawChannel = new Channel<NvimEvent>();
        redrawChannel.onmessage = (event) => {
          if (!alive) return;
          renderer.handleEvent(event);
          // Forward dirty state changes to parent
          if (event.type === "dirty_change") {
            onDirtyChangeRef.current?.((event as any).modified);
          }
        };

        const exitChannel = new Channel<number>();
        exitChannel.onmessage = (code) => {
          if (!alive) return;
          console.log("neovim exited with code", code);
          onClose?.();
        };

        try {
          const bufnr = await invoke<number>("nvim_open", {
            path,
            cols,
            rows,
            on_redraw: redrawChannel,
            on_exit: exitChannel,
          });
          if (alive) {
            bufnrRef.current = bufnr;
          }
        } catch (err) {
          console.error("Failed to open neovim:", err);
        }
      }

      void init();

      return () => {
        alive = false;
        renderer.destroy();
        rendererRef.current = null;
        // Close the neovim instance
        if (bufnrRef.current) {
          void invoke("nvim_close", { bufnr: bufnrRef.current }).catch(
            () => undefined,
          );
        }
      };
    }, [path]);

    // Keyboard input handling
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const handleKeyDown = (e: KeyboardEvent) => {
        const meta = e.metaKey || e.ctrlKey;

        // App-level shortcuts that should NOT go to neovim
        if (meta && (e.key === "t" || e.key === "Tab" || e.key === ",")) {
          return; // Let the browser handle these
        }

        // Cmd+S → save in neovim
        if (meta && e.key === "s") {
          e.preventDefault();
          void invoke("nvim_input", { keys: "<Esc>:w<CR>" }).then(() => {
            onSavedRef.current?.();
          });
          return;
        }

        // Cmd+Z → undo in neovim
        if (meta && !e.shiftKey && e.key === "z") {
          e.preventDefault();
          void invoke("nvim_input", { keys: "<Esc>:undo<CR>" });
          return;
        }

        // Cmd+Shift+Z → redo in neovim
        if (meta && e.shiftKey && e.key === "z") {
          e.preventDefault();
          void invoke("nvim_input", { keys: "<Esc>:redo<CR>" });
          return;
        }

        e.preventDefault();

        const keys = translateKeyEvent(e);
        if (keys) {
          void invoke("nvim_input", { keys }).catch(console.error);
        }
      };

      const handleBeforeInput = (e: InputEvent) => {
        if (e.data && !e.isComposing) {
          e.preventDefault();
          void invoke("nvim_input", { keys: e.data }).catch(console.error);
        }
      };

      container.addEventListener("keydown", handleKeyDown);
      container.addEventListener("beforeinput", handleBeforeInput);

      return () => {
        container.removeEventListener("keydown", handleKeyDown);
        container.removeEventListener("beforeinput", handleBeforeInput);
      };
    }, []);

    // Resize handling
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const cols = Math.max(40, Math.floor(entry.contentRect.width / 8));
          const rows = Math.max(10, Math.floor(entry.contentRect.height / 20));

          if (rendererRef.current) {
            rendererRef.current.resize(cols, rows);
          }

          void invoke("nvim_resize", { cols, rows }).catch(console.error);
        }
      });

      observer.observe(container);
      return () => observer.disconnect();
    }, []);

    // Expose handle for EditorStack
    useImperativeHandle(
      ref,
      () => ({
        focus: () => containerRef.current?.focus(),
        getPath: () => pathRef.current,
        reload: () => {
          void invoke("nvim_input", { keys: "<Esc>:e!<CR>" });
          return true;
        },
        undo: () => {
          void invoke("nvim_input", { keys: "<Esc>:undo<CR>" });
        },
        redo: () => {
          void invoke("nvim_input", { keys: "<Esc>:redo<CR>" });
        },
      }),
      [],
    );

    return (
      <div
        ref={containerRef}
        tabIndex={0}
        className="h-full w-full overflow-hidden bg-background outline-none font-mono"
        style={{
          fontSize: "13px",
          lineHeight: "1.55",
          cursor: "text",
        }}
      />
    );
  },
);

// Key translation helper — converts browser KeyboardEvent to neovim key notation
function translateKeyEvent(e: KeyboardEvent): string | null {
  const meta = e.metaKey || e.ctrlKey;
  const alt = e.altKey;
  const shift = e.shiftKey;
  let key = e.key;

  // Map special keys to neovim notation
  const specialKeys: Record<string, string> = {
    Enter: "<CR>",
    Tab: "<Tab>",
    Escape: "<Esc>",
    Backspace: "<BS>",
    Delete: "<Del>",
    Home: "<Home>",
    End: "<End>",
    PageUp: "<PageUp>",
    PageDown: "<PageDown>",
    ArrowUp: "<Up>",
    ArrowDown: "<Down>",
    ArrowLeft: "<Left>",
    ArrowRight: "<Right>",
    " ": "<Space>",
  };

  if (specialKeys[key]) {
    // Build modifier prefix for special keys
    let prefix = "";
    if (meta && !alt) prefix = "C-";
    else if (alt && !meta) prefix = "M-";
    else if (meta && alt) prefix = "C-M-";

    if (prefix) {
      // Strip angle brackets from the key name for modifier prefix
      const inner = specialKeys[key].slice(1, -1);
      return `<${prefix}${inner}>`;
    }
    return specialKeys[key];
  }

  // Handle Ctrl/Cmd combinations with regular keys
  if (meta && key.length === 1) {
    return `<C-${key.toLowerCase()}>`;
  }

  // Handle Alt combinations
  if (alt && key.length === 1) {
    return `<M-${key.toLowerCase()}>`;
  }

  // Regular character
  if (key.length === 1) {
    if (shift) {
      return key.toUpperCase();
    }
    return key;
  }

  // F-keys
  if (key.startsWith("F") && key.length <= 3) {
    return `<${key}>`;
  }

  return null;
}