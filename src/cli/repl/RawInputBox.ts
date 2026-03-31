/**
 * RawInputBox
 *
 * Renders a highlighted input zone using raw terminal mode.
 * Uses a faint-yellow background fill (via ANSI EL) — no border lines needed.
 * Input text wraps naturally; the highlight follows.
 *
 *   [faint-yellow bg]  epam › user types here naturally  [fill to EOL]
 *   [faint-yellow bg]  overflow continues here            [fill to EOL]
 */

import { EventEmitter } from 'events';

// Dark gray / "light black" background (ANSI 256-color 238 = #444444)
// Bright yellow foreground (ANSI 93) for high contrast
const BG    = '\x1b[48;5;238m';
const FG    = '\x1b[93m';
const RESET = '\x1b[0m';
const EL    = '\x1b[K'; // erase to end of line (fills bg without moving cursor)
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END   = '\x1b[201~';
const BRACKETED_ENABLE      = '\x1b[?2004h';
const BRACKETED_DISABLE     = '\x1b[?2004l';

export interface RawInputOptions {
  /** Slash command names (and aliases) to use for Tab completion. */
  completions?: string[];
}

export interface RawInputResult {
  line: string;
  interrupted: boolean;
}

export class RawInputBox {
  private buffer = '';
  private cursorPos = 0;
  private history: string[] = [];
  private historyIdx = -1;
  private historySaved = '';
  private lastCursorLineInInput = 0;
  private boxInputLines = 1; // number of input content lines currently drawn
  // Tab completion state
  private tabCycleList: string[] = [];
  private tabCycleIdx = 0;
  readonly interruptBus: EventEmitter;

  constructor(interruptBus?: EventEmitter) {
    this.interruptBus = interruptBus || new EventEmitter();
  }

  addHistory(line: string): void {
    if (line.trim() && this.history[0] !== line) {
      this.history.unshift(line);
      if (this.history.length > 500) this.history.pop();
    }
  }

  async readLine(prefix: string, options: RawInputOptions = {}): Promise<RawInputResult> {
    this.buffer = '';
    this.cursorPos = 0;
    this.historyIdx = -1;
    this.historySaved = '';
    this.tabCycleList = [];
    this.tabCycleIdx = 0;

    if (!process.stdout.isTTY) {
      return this.readLineSimple(prefix);
    }

    return new Promise<RawInputResult>((resolve) => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      const bracketedSupported = !!process.stdout.isTTY;
      if (bracketedSupported) process.stdout.write(BRACKETED_ENABLE);

      this.drawBox(prefix);

      let resolved = false;
      let inBracketedPaste = false;
      const finish = (result: RawInputResult) => {
        if (resolved) return;
        resolved = true;
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        if (bracketedSupported) process.stdout.write(BRACKETED_DISABLE);
        inBracketedPaste = false;
        resolve(result);
      };

      const insertText = (text: string) => {
        if (!text) return;
        let changed = false;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (ch === '\r') {
            if (text[i + 1] === '\n') continue;
            this.buffer = this.buffer.slice(0, this.cursorPos) + '\n' + this.buffer.slice(this.cursorPos);
            this.cursorPos++;
            changed = true;
            continue;
          }
          if (ch === '\n' || ch === '\t' || ch >= ' ') {
            this.buffer = this.buffer.slice(0, this.cursorPos) + ch + this.buffer.slice(this.cursorPos);
            this.cursorPos++;
            changed = true;
          }
        }
        if (changed) this.redrawBox(prefix);
      };

      const handleKeySequence = (str: string) => {
        if (!str) return;

        if (str === '\r' || str === '\n') {
          if (!this.buffer.trim()) return; // ignore blank Enter
          if (!resolved) this.clearBoxAndEcho(prefix);
          finish({ line: this.buffer, interrupted: false });

        } else if (str === '\x03') {
          // Ctrl+C
          if (!resolved) this.clearBoxAndEcho(prefix);
          this.interruptBus.emit('interrupt');
          finish({ line: '', interrupted: true });

        } else if (str === '\t' || str === '\x1b[Z' || str === '\x1b[[Z') {
          // Tab (forward) / Shift+Tab (backward)
          // Both sequences cycle slash completions from any buffer state.
          const forward = str === '\t';
          this.handleTab(prefix, options.completions ?? [], forward);

        } else if (str === '\x7f' || str === '\x08') {
          // Backspace
          if (this.cursorPos > 0) {
            this.buffer = this.buffer.slice(0, this.cursorPos - 1) + this.buffer.slice(this.cursorPos);
            this.cursorPos--;
            this.redrawBox(prefix);
          }

        } else if (str === '\x1b[3~') {
          // Delete forward
          if (this.cursorPos < this.buffer.length) {
            this.buffer = this.buffer.slice(0, this.cursorPos) + this.buffer.slice(this.cursorPos + 1);
            this.redrawBox(prefix);
          }

        } else if (str === '\x1b[C' || str === '\x1bOC') {
          // Right arrow
          if (this.cursorPos < this.buffer.length) { this.cursorPos++; this.updateCursor(prefix); }

        } else if (str === '\x1b[D' || str === '\x1bOD') {
          // Left arrow
          if (this.cursorPos > 0) { this.cursorPos--; this.updateCursor(prefix); }

        } else if (str === '\x1b[H' || str === '\x01') {
          // Home / Ctrl+A
          this.cursorPos = 0; this.updateCursor(prefix);

        } else if (str === '\x1b[F' || str === '\x05') {
          // End / Ctrl+E
          this.cursorPos = this.buffer.length; this.updateCursor(prefix);

        } else if (str === '\x1b[A' || str === '\x1bOA') {
          // Up — history prev
          if (this.historyIdx === -1) this.historySaved = this.buffer;
          if (this.historyIdx < this.history.length - 1) {
            this.historyIdx++;
            this.buffer = this.history[this.historyIdx];
            this.cursorPos = this.buffer.length;
            this.redrawBox(prefix);
          }

        } else if (str === '\x1b[B' || str === '\x1bOB') {
          // Down — history next
          if (this.historyIdx > 0) {
            this.historyIdx--;
            this.buffer = this.history[this.historyIdx];
          } else if (this.historyIdx === 0) {
            this.historyIdx = -1;
            this.buffer = this.historySaved;
          }
          this.cursorPos = this.buffer.length;
          this.redrawBox(prefix);

        } else if (str === '\x0C') {
          // Ctrl+L — clear screen
          process.stdout.write('\x1b[2J\x1b[H');
          this.lastCursorLineInInput = 0;
          this.boxInputLines = 1;
          this.tabCycleList = [];
          this.drawBox(prefix);

        } else if (str >= ' ') {
          // Printable (handles pasted multi-char sequences too)
          insertText(str);
        }
      };

      const processChunk = (chunk: string): void => {
        if (!chunk) return;
        if (inBracketedPaste) {
          const endIdx = chunk.indexOf(BRACKETED_PASTE_END);
          if (endIdx === -1) {
            insertText(chunk);
            return;
          }
          insertText(chunk.slice(0, endIdx));
          inBracketedPaste = false;
          processChunk(chunk.slice(endIdx + BRACKETED_PASTE_END.length));
          return;
        }
        const startIdx = chunk.indexOf(BRACKETED_PASTE_START);
        if (startIdx !== -1) {
          if (startIdx > 0) processChunk(chunk.slice(0, startIdx));
          inBracketedPaste = true;
          processChunk(chunk.slice(startIdx + BRACKETED_PASTE_START.length));
          return;
        }
        let remaining = chunk;
        while (remaining.length) {
          const newlineIdx = remaining.search(/[\r\n]/);
          if (newlineIdx === -1) {
            handleKeySequence(remaining);
            break;
          }
          const before = remaining.slice(0, newlineIdx);
          if (before) handleKeySequence(before);
          handleKeySequence(remaining[newlineIdx]);
          remaining = remaining.slice(newlineIdx + 1);
        }
      };

      const onData = (str: string) => {
        // Any key other than Tab resets the tab cycle
        if (str !== '\t' && str !== '\x1b[Z' && str !== '\x1b[[Z') {
          this.tabCycleList = [];
          this.tabCycleIdx = 0;
        }
        processChunk(str);
      };

      process.stdin.on('data', onData);
    });
  }

  // ── Drawing helpers ────────────────────────────────────────────────────────

  private cols(): number { return process.stdout.columns || 80; }

  /** Strip ANSI escape sequences to get the visible character count. */
  private stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  private visibleLen(s: string): number {
    return this.stripAnsi(s).length;
  }

  /**
   * Wrap plain-text content (respecting newline characters) into terminal-width chunks.
   * Input must already be ANSI-free (visible chars only).
   */
  private wrap(text: string, cols: number): string[] {
    if (text.length === 0) return [''];
    const width = Math.max(1, cols);
    const lines: string[] = [];
    let current = '';
    for (const ch of text) {
      if (ch === '\n') {
        lines.push(current);
        current = '';
        continue;
      }
      current += ch;
      if (current.length === width) {
        lines.push(current);
        current = '';
      }
    }
    lines.push(current);
    return lines;
  }

  /**
   * Compute the cursor line/column offset within the input region, accounting for wrapping/newlines.
   */
  private measureCursor(prefix: string, cols: number): { line: number; col: number } {
    const width = Math.max(1, cols);
    const vpText = this.stripAnsi(prefix);
    const upto = vpText + this.buffer.slice(0, this.cursorPos);
    let line = 0;
    let col = 0;
    for (const ch of upto) {
      if (ch === '\n') {
        line++;
        col = 0;
        continue;
      }
      col++;
      if (col === width) {
        line++;
        col = 0;
      }
    }
    return { line, col };
  }

  /**
   * Render one highlighted input line to stdout.
   * Uses BG + FG + content + EL (erase-to-EOL fills background).
   */
  private writeLine(content: string): void {
    process.stdout.write(BG + FG + content + EL + RESET);
  }

  /** Render one highlighted blank padding line (same colour, no text). */
  private writePadLine(): void {
    process.stdout.write(BG + EL + RESET);
  }

  // ── Tab completion ─────────────────────────────────────────────────────────

  /**
   * Tab/Shift+Tab cycles through slash-command completions.
   * Works from any buffer state:
   *   - empty buffer → cycles all commands starting from '/'
   *   - buffer starts with '/' → cycles matching completions
   *   - other buffer content → cycles all commands (non-destructive: saves/restores)
   * Shift+Tab always cycles backward.
   */
  private handleTab(prefix: string, completions: string[], forward: boolean): void {
    // Only activate slash-command completion when buffer is empty or starts with '/'
    if (this.tabCycleList.length === 0 && this.buffer.length > 0 && !this.buffer.startsWith('/')) {
      return;
    }

    // Build or advance the cycle list
    if (this.tabCycleList.length === 0) {
      // Determine the partial to filter on
      const partial = this.buffer.startsWith('/')
        ? this.buffer.slice(1).toLowerCase()
        : '';
      this.tabCycleList = completions
        .filter(c => c.startsWith(partial))
        .map(c => '/' + c);
      if (this.tabCycleList.length === 0) return;
      this.tabCycleIdx = forward ? 0 : this.tabCycleList.length - 1;
    } else {
      this.tabCycleIdx = forward
        ? (this.tabCycleIdx + 1) % this.tabCycleList.length
        : (this.tabCycleIdx - 1 + this.tabCycleList.length) % this.tabCycleList.length;
    }
    this.buffer   = this.tabCycleList[this.tabCycleIdx];
    this.cursorPos = this.buffer.length;
    this.redrawBox(prefix);
  }

  // ── Layout: [top-pad] [input lines...] [bottom-pad]
  //
  // After drawBox/redrawBox the cursor is left INSIDE the input area.
  // lastCursorLineInInput tracks which input line (0-indexed) the cursor is on.
  //
  // Helpers use these invariants:
  //   • positionCursor  — called when cursor is at END of bottom-pad; moves up into input
  //   • redrawBox       — cursor is at lastCursorLineInInput; go up to top-pad, redraw
  //   • clearBoxAndEcho — cursor is at lastCursorLineInInput; go up to top-pad, clear, echo

  /**
   * Draw the entire box (top-pad + input lines + bottom-pad) from the current
   * terminal cursor position. Leaves cursor inside the input area.
   */
  private drawBox(prefix: string): void {
    const cols   = this.cols();
    const vpLen  = this.visibleLen(prefix);
    const vpText = this.stripAnsi(prefix);
    const inputLines = this.wrap(vpText + this.buffer, cols);

    // Top pad
    this.writePadLine();
    process.stdout.write('\n');

    // Input lines
    for (let i = 0; i < inputLines.length; i++) {
      if (i > 0) process.stdout.write('\n');
      const content = i === 0
        ? prefix + inputLines[0].slice(vpLen)
        : inputLines[i];
      this.writeLine(content);
    }

    // Bottom pad — cursor ends up here after write
    process.stdout.write('\n');
    this.writePadLine();

    this.boxInputLines = inputLines.length;
    this.positionCursor(prefix, cols, inputLines);
  }

  /**
   * Erase the entire box and redraw it. Called after every buffer change.
   * Cursor starts at lastCursorLineInInput inside the input area.
   */
  private redrawBox(prefix: string): void {
    const cols   = this.cols();
    const vpLen  = this.visibleLen(prefix);
    const vpText = this.stripAnsi(prefix);
    const inputLines = this.wrap(vpText + this.buffer, cols);

    // From input cursor → top-pad: lastCursorLineInInput rows up + 1 for the top-pad itself
    // CPL moves up N lines and goes to column 1.
    process.stdout.write(`\x1b[${this.lastCursorLineInInput + 1}F`);
    process.stdout.write('\x1b[0J'); // clear to end of display

    // Top pad
    this.writePadLine();
    process.stdout.write('\n');

    // Input lines
    for (let i = 0; i < inputLines.length; i++) {
      if (i > 0) process.stdout.write('\n');
      const content = i === 0
        ? prefix + inputLines[0].slice(vpLen)
        : inputLines[i];
      this.writeLine(content);
    }

    // Bottom pad
    process.stdout.write('\n');
    this.writePadLine();

    this.boxInputLines = inputLines.length;
    this.positionCursor(prefix, cols, inputLines);
  }

  /**
   * Move cursor from end of bottom-pad up into the correct input cell.
   * Called at the end of drawBox / redrawBox.
   */
  private positionCursor(prefix: string, cols: number, inputLines: string[]): void {
    const { line: cursorLine, col: cursorCol } = this.measureCursor(prefix, cols);
    // Cursor is at end of bottom-pad. Rows up to cursorLine:
    //   1 row  → bottom-pad to last input line
    //   (inputLines.length - 1 - cursorLine) → last input line to cursorLine
    // total = inputLines.length - cursorLine
    const rowsUp = inputLines.length - cursorLine;
    if (rowsUp > 0) process.stdout.write(`\x1b[${rowsUp}A`); // CUU
    process.stdout.write(`\x1b[${cursorCol + 1}G`);           // CHA (1-indexed)
    this.lastCursorLineInInput = cursorLine;
  }

  /**
   * Move cursor left/right/home/end without redrawing.
   * Cursor stays within the input area; no padding involved.
   */
  private updateCursor(prefix: string): void {
    const cols = this.cols();
    const { line: newLine, col: newCol } = this.measureCursor(prefix, cols);
    const delta = newLine - this.lastCursorLineInInput;
    if (delta > 0)      process.stdout.write(`\x1b[${delta}B`);
    else if (delta < 0) process.stdout.write(`\x1b[${-delta}A`);
    process.stdout.write(`\x1b[${newCol + 1}G`);
    this.lastCursorLineInInput = newLine;
  }

  /**
   * On Enter/Ctrl+C: erase entire box and echo the typed line cleanly.
   * Cursor starts at lastCursorLineInInput inside the input area.
   */
  private clearBoxAndEcho(prefix: string): void {
    // Go to start of top-pad: up (lastCursorLineInInput + 1) lines, col 1
    process.stdout.write(`\x1b[${this.lastCursorLineInInput + 1}F`);
    process.stdout.write('\x1b[0J');
    process.stdout.write(prefix + this.buffer + '\n');
  }

  private async readLineSimple(prefix: string): Promise<RawInputResult> {
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(prefix, (line) => { rl.close(); resolve({ line, interrupted: false }); });
    });
  }
}
