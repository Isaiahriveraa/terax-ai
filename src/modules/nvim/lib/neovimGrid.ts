import { detectMonoFontFamily } from "@/lib/fonts";
import type { CellData, HlAttr, NvimEvent } from "./types";

/**
 * DOM row-span grid renderer for Neovim.
 *
 * Renders neovim's grid using one <div> per row, each containing <span>
 * elements for text runs with the same style. Coalesces adjacent cells with
 * the same hl_id into a single span for performance.
 *
 * Only handles grid 1 (main grid) since ext_multigrid is off.
 */
export class NeovimGridRenderer {
  private container: HTMLDivElement;
  private rows: HTMLDivElement[] = [];
  private cols = 80;
  private rowsCount = 24;
  private cursorRow = 0;
  private cursorCol = 0;
  private cellWidth = 0;
  private cellHeight = 0;
  private dirtyRows: Set<number> = new Set();
  private defaultFg = "#ffffff";
  private defaultBg = "#1a1a2e";
  private currentMode = "normal";
  private hlAttrs: Map<number, HlAttr> = new Map();
  private gridData: string[][] = [];
  private gridHl: number[][] = [];

  constructor(container: HTMLDivElement) {
    this.container = container;
    this.measureCell();
    this.initGrid(this.cols, this.rowsCount);
  }

  // --- Public API ---

  handleEvent(event: NvimEvent): void {
    const e = event as Record<string, unknown>;
    switch (event.type) {
      case "grid_resize":
        this.handleGridResize(e.grid as number, e.width as number, e.height as number);
        break;
      case "grid_line":
        this.handleGridLine(e.grid as number, e.row as number, e.col_start as number, e.cells as CellData[]);
        break;
      case "grid_clear":
        this.handleGridClear(e.grid as number);
        break;
      case "grid_cursor_goto":
        this.handleGridCursorGoto(e.grid as number, e.row as number, e.col as number);
        break;
      case "grid_scroll":
        this.handleGridScroll(
          e.grid as number,
          e.top as number,
          e.bottom as number,
          e.left as number,
          e.right as number,
          e.rows as number,
        );
        break;
      case "flush":
        this.flush();
        break;
      case "mode_change":
        this.currentMode = e.mode as string;
        break;
      case "default_colors_set":
        this.handleDefaultColorsSet(e.fg as number, e.bg as number);
        break;
      case "hl_attr_define": {
        const id = e.id as number | undefined;
        const attr: HlAttr = {};
        if (e.foreground !== undefined) attr.foreground = e.foreground as number;
        if (e.background !== undefined) attr.background = e.background as number;
        if (e.bold !== undefined) attr.bold = !!e.bold;
        if (e.italic !== undefined) attr.italic = !!e.italic;
        if (e.underline !== undefined) attr.underline = !!e.underline;
        if (e.undercurl !== undefined) attr.undercurl = !!e.undercurl;
        if (e.strikethrough !== undefined) attr.strikethrough = !!e.strikethrough;
        if (e.reverse !== undefined) attr.reverse = !!e.reverse;
        if (id !== undefined) this.hlAttrs.set(id, attr);
        break;
      }
      case "set_title":
        // Title changes are handled by the tab system
        break;
      case "dirty_change":
        // Dirty state forwarded to parent via callback
        break;
      default:
        // Unknown event — ignore
        break;
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rowsCount = rows;
    this.initGrid(cols, rows);
    this.rebuildDom();
  }

  destroy(): void {
    this.container.innerHTML = "";
    this.rows = [];
    this.gridData = [];
    this.gridHl = [];
  }

  // --- Grid event handlers ---

  private handleGridResize(
    grid: number,
    width: number,
    height: number,
  ): void {
    if (grid !== 1) return;
    this.cols = width;
    this.rowsCount = height;
    this.initGrid(width, height);
    this.rebuildDom();
  }

  private handleGridLine(
    grid: number,
    row: number,
    colStart: number,
    cells: CellData[],
  ): void {
    if (grid !== 1) return;
    if (row >= this.rowsCount) return;

    let col = colStart;
    let prevHlId = 0;

    for (const cell of cells) {
      const hlId = cell.hl_id !== undefined ? cell.hl_id : prevHlId;
      const repeat = cell.repeat ?? 1;
      const text = cell.text;

      for (let i = 0; i < repeat; i++) {
        if (col >= this.cols) break;

        if (text === "") {
          // Wide char continuation — cell is occupied by the wide char
          // in the previous column. Keep previous hl, advance col.
          col++;
          continue;
        }

        this.gridData[row][col] = text;
        this.gridHl[row][col] = hlId;
        col++;
      }

      prevHlId = hlId;
    }

    this.dirtyRows.add(row);
  }

  private handleGridClear(grid: number): void {
    if (grid !== 1) return;
    for (let r = 0; r < this.rowsCount; r++) {
      for (let c = 0; c < this.cols; c++) {
        this.gridData[r][c] = " ";
        this.gridHl[r][c] = 0;
      }
      this.dirtyRows.add(r);
    }
  }

  private handleGridCursorGoto(
    grid: number,
    row: number,
    col: number,
  ): void {
    if (grid !== 1) return;
    const oldRow = this.cursorRow;
    this.cursorRow = row;
    this.cursorCol = col;
    this.dirtyRows.add(oldRow);
    this.dirtyRows.add(row);
  }

  private handleGridScroll(
    grid: number,
    top: number,
    bottom: number,
    left: number,
    right: number,
    rows: number,
  ): void {
    if (grid !== 1) return;

    // Positive rows = scroll up (content moves down)
    // Negative rows = scroll down (content moves up)
    if (rows > 0) {
      // Scroll up: copy rows upward
      for (let r = top; r < bottom - rows; r++) {
        this.gridData[r] = [...this.gridData[r + rows]];
        this.gridHl[r] = [...this.gridHl[r + rows]];
      }
      // Clear the bottom rows
      for (let r = bottom - rows; r < bottom; r++) {
        for (let c = left; c < right; c++) {
          this.gridData[r][c] = " ";
          this.gridHl[r][c] = 0;
        }
      }
    } else if (rows < 0) {
      // Scroll down: copy rows downward
      const count = -rows;
      for (let r = bottom - 1; r >= top + count; r--) {
        this.gridData[r] = [...this.gridData[r - count]];
        this.gridHl[r] = [...this.gridHl[r - count]];
      }
      // Clear the top rows
      for (let r = top; r < top + count; r++) {
        for (let c = left; c < right; c++) {
          this.gridData[r][c] = " ";
          this.gridHl[r][c] = 0;
        }
      }
    }

    // Mark all affected rows as dirty
    for (let r = top; r < bottom; r++) {
      this.dirtyRows.add(r);
    }

    // Also shift DOM row elements for performance
    this.shiftDomRows(top, bottom, rows);
  }

  private handleDefaultColorsSet(fg: number, bg: number): void {
    this.defaultFg = this.colorToCss(fg);
    this.defaultBg = this.colorToCss(bg);
    // Mark all rows dirty since default colors changed
    for (let r = 0; r < this.rowsCount; r++) {
      this.dirtyRows.add(r);
    }
  }

  // --- Rendering ---

  private flush(): void {
    if (this.dirtyRows.size === 0) return;

    for (const rowIdx of this.dirtyRows) {
      if (rowIdx < this.rows.length) {
        const rowEl = this.rows[rowIdx];
        const rendered = this.renderRow(rowIdx);
        rowEl.replaceChildren(...rendered.childNodes);
      }
    }

    // Render cursor
    this.renderCursor();

    this.dirtyRows.clear();
    this.dirtyRows.clear();
  }

  private renderRow(rowIdx: number): HTMLDivElement {
    const rowEl = document.createElement("div");
    rowEl.className = "nvim-row";
    rowEl.style.height = `${this.cellHeight}px`;
    rowEl.style.lineHeight = `${this.cellHeight}px`;
    rowEl.style.whiteSpace = "pre";

    const rowData = this.gridData[rowIdx];
    const rowHl = this.gridHl[rowIdx];
    if (!rowData) return rowEl;

    // Coalesce adjacent cells with the same hl_id into a single span
    let currentHl = rowHl[0] ?? 0;
    let currentText = "";
    let span: HTMLSpanElement | null = null;

    const flushSpan = () => {
      if (!span || currentText === "") return;
      span.textContent = currentText;
      rowEl.appendChild(span);
      currentText = "";
    };

    for (let c = 0; c < this.cols; c++) {
      const ch = rowData[c] ?? " ";
      const hl = rowHl[c] ?? 0;

      if (hl !== currentHl) {
        // Style changed — flush current span and start a new one
        flushSpan();
        currentHl = hl;
        span = document.createElement("span");
        this.applyHlStyle(span, hl);
        currentText = ch;
      } else {
        currentText += ch;
      }
    }

    // Flush remaining text
    if (currentText !== "") {
      if (!span) {
        span = document.createElement("span");
        this.applyHlStyle(span, currentHl);
      }
      span.textContent = currentText;
      rowEl.appendChild(span);
    }

    return rowEl;
  }

  private applyHlStyle(span: HTMLSpanElement, hlId: number): void {
    if (hlId === 0) {
      // Default style — no inline overrides needed
      return;
    }

    const attr = this.hlAttrs.get(hlId);
    if (!attr) return;

    const styles: string[] = [];

    const fg = attr.foreground !== undefined
      ? this.colorToCss(attr.foreground)
      : this.defaultFg;
    const bg = attr.background !== undefined
      ? this.colorToCss(attr.background)
      : this.defaultBg;

    if (attr.reverse) {
      styles.push(`color:${bg}`);
      styles.push(`background-color:${fg}`);
    } else {
      if (attr.foreground !== undefined) styles.push(`color:${fg}`);
      if (attr.background !== undefined) styles.push(`background-color:${bg}`);
    }

    if (attr.bold) styles.push("font-weight:bold");
    if (attr.italic) styles.push("font-style:italic");
    if (attr.underline) styles.push("text-decoration:underline");
    if (attr.undercurl) styles.push("text-decoration:underline wavy");
    if (attr.strikethrough) styles.push("text-decoration:line-through");

    if (styles.length > 0) {
      span.style.cssText = styles.join(";");
    }
  }

  private renderCursor(): void {
    // Remove any existing cursor
    const existing = this.container.querySelector(".nvim-cursor");
    if (existing) existing.remove();

    if (this.cursorRow >= this.rowsCount || this.cursorCol >= this.cols)
      return;

    const rowEl = this.rows[this.cursorRow];
    if (!rowEl) return;

    const cursor = document.createElement("span");
    cursor.className = "nvim-cursor";

    if (this.currentMode === "insert" || this.currentMode.startsWith("i")) {
      // Bar cursor for insert mode
      cursor.style.cssText = `
        position: absolute;
        left: ${this.cursorCol * this.cellWidth}px;
        top: ${this.cursorRow * this.cellHeight}px;
        width: 2px;
        height: ${this.cellHeight}px;
        background-color: ${this.defaultFg};
        pointer-events: none;
        z-index: 10;
      `;
    } else {
      // Block cursor for normal/visual/etc
      cursor.style.cssText = `
        position: absolute;
        left: ${this.cursorCol * this.cellWidth}px;
        top: ${this.cursorRow * this.cellHeight}px;
        width: ${this.cellWidth}px;
        height: ${this.cellHeight}px;
        background-color: ${this.defaultFg};
        opacity: 0.5;
        pointer-events: none;
        z-index: 10;
      `;
    }

    this.container.appendChild(cursor);
  }

  // --- DOM management ---

  private initGrid(cols: number, rows: number): void {
    this.gridData = [];
    this.gridHl = [];
    for (let r = 0; r < rows; r++) {
      this.gridData.push(new Array(cols).fill(" "));
      this.gridHl.push(new Array(cols).fill(0));
    }
  }

  private rebuildDom(): void {
    this.container.innerHTML = "";
    this.rows = [];

    this.container.style.position = "relative";
    this.container.style.fontFamily = detectMonoFontFamily();
    this.container.style.fontSize = "13px";
    this.container.style.lineHeight = "1.55";
    this.container.style.backgroundColor = this.defaultBg;
    this.container.style.color = this.defaultFg;
    this.container.style.overflow = "hidden";

    for (let r = 0; r < this.rowsCount; r++) {
      const rowEl = document.createElement("div");
      rowEl.className = "nvim-row";
      rowEl.style.height = `${this.cellHeight}px`;
      rowEl.style.lineHeight = `${this.cellHeight}px`;
      rowEl.style.whiteSpace = "pre";
      this.container.appendChild(rowEl);
      this.rows.push(rowEl);
    }

    // Mark all rows dirty
    for (let r = 0; r < this.rowsCount; r++) {
      this.dirtyRows.add(r);
    }
  }

  private shiftDomRows(top: number, bottom: number, rows: number): void {
    if (rows === 0) return;

    // Detach row elements from the container for the scroll region
    const regionRows = this.rows.slice(top, bottom);

    if (rows > 0) {
      // Scroll up: move rows upward
      const moved = regionRows.slice(rows);
      const cleared = regionRows.slice(0, rows);
      // Reorder: moved rows come first, cleared rows go to bottom
      for (let i = 0; i < moved.length; i++) {
        this.rows[top + i] = moved[i];
      }
      for (let i = 0; i < cleared.length; i++) {
        this.rows[top + moved.length + i] = cleared[i];
      }
    } else {
      // Scroll down: move rows downward
      const count = -rows;
      const moved = regionRows.slice(0, regionRows.length - count);
      const cleared = regionRows.slice(regionRows.length - count);
      for (let i = moved.length - 1; i >= 0; i--) {
        this.rows[top + count + i] = moved[i];
      }
      for (let i = 0; i < cleared.length; i++) {
        this.rows[top + i] = cleared[i];
      }
    }

    // Re-attach rows in order
    for (let i = top; i < bottom; i++) {
      if (this.rows[i] && this.rows[i].parentNode === this.container) {
        this.container.appendChild(this.rows[i]);
      }
    }
  }

  private measureCell(): void {
    // Measure a single character cell using the same font settings
    const measure = document.createElement("span");
    measure.textContent = "M";
    measure.style.cssText = `
      position: absolute;
      visibility: hidden;
      white-space: pre;
      font-family: ${detectMonoFontFamily()};
      font-size: 13px;
      line-height: 1.55;
    `;
    document.body.appendChild(measure);
    this.cellWidth = measure.getBoundingClientRect().width;
    this.cellHeight = measure.getBoundingClientRect().height;
    document.body.removeChild(measure);

    // Fallback if measurement fails
    if (this.cellWidth <= 0) this.cellWidth = 8;
    if (this.cellHeight <= 0) this.cellHeight = 20;
  }

  // --- Color utilities ---

  private colorToCss(color: number): string {
    if (color === -1) return this.defaultFg;
    // Neovim sends colors as 0xRRGGBB
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    return `rgb(${r},${g},${b})`;
  }
}