/**
 * Shared types matching the Rust backend's NvimEvent wire format.
 * The frontend only renders — no msgpack knowledge needed.
 */

export interface CellData {
  text: string;
  hl_id?: number;
  repeat?: number;
}

export type NvimEvent =
  | { type: "grid_resize"; grid: number; width: number; height: number }
  | { type: "grid_line"; grid: number; row: number; col_start: number; cells: CellData[] }
  | { type: "grid_clear"; grid: number }
  | { type: "grid_cursor_goto"; grid: number; row: number; col: number }
  | {
      type: "grid_scroll";
      grid: number;
      top: number;
      bottom: number;
      left: number;
      right: number;
      rows: number;
    }
  | { type: "flush" }
  | { type: "mode_change"; mode: string }
  | { type: "default_colors_set"; fg: number; bg: number }
  | { type: "set_title"; title: string }
  | { type: "dirty_change"; bufnr: number; modified: boolean }
  | { type: string; [key: string]: unknown };

export interface NeovimEditorHandle {
  focus: () => void;
  getPath: () => string;
  reload: () => boolean;
  undo: () => void;
  redo: () => void;
}

/** Highlight attribute definition from nvim's hl_attr_define events. */
export interface HlAttr {
  foreground?: number;
  background?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  undercurl?: boolean;
  strikethrough?: boolean;
  reverse?: boolean;
}