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

// Very faint yellow background (ANSI 256-color 230 = #ffffd7, ~60% lighter than 229)
// Black foreground (ANSI 30) for maximum readability on the light background
const BG    = '\x1b[48;5;230m';
const FG    = '\x1b[30m';
const RESET = '\x1b[0m';
const EL    = '\x1b[K'; // erase to end of line (fills bg without moving cursor)

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

  async readLine(prefix: string): Promise<RawInputResult> {
    this.buffer = '';
    this.cursorPos = 0;
    this.historyIdx = -1;
    this.historySaved = '';

    if (!process.stdout.isTTY) {
      return this.readLineSimple(prefix);
    }

    return new Promise<RawInputResult>((resolve) => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      this.drawBox(prefix);

      let resolved = false;
      const finish = (result: RawInputResult) => {
        if (resolved) return;
        resolved = true;
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(result);
      };

      const onData = (str: string) => {
        if (str === '\r' || str === '\n') {
          this.clearBoxAndEcho(prefix);
          finish({ line: this.buffer, interrupted: false });

        } else if (str === '\x03') {
          // Ctrl+C
          this.clearBoxAndEcho(prefix);
          this.interruptBus.emit('interrupt');
          finish({ line: '', interrupted: true });

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
          this.drawBox(prefix);

        } else if (str >= ' ') {
          // Printable (handles pasted multi-char sequences too)
          for (const ch of str) {
            if (ch >= ' ') {
              this.buffer = this.buffer.slice(0, this.cursorPos) + ch + this.buffer.slice(this.cursorPos);
              this.cursorPos++;
            }
          }
          this.redrawBox(prefix);
        }
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
   * Wrap plain-text content into terminal-width chunks.
   * Input must already be ANSI-free (visible chars only).
   */
  private wrap(text: string, cols: number): string[] {
    if (text.length === 0) return [''];
    const lines: string[] = [];
    for (let i = 0; i < text.length; i += cols) lines.push(text.slice(i, i + cols));
    return lines;
  }

  /**
   * Render one highlighted input line to stdout.
   * Uses BG + content + EL (erase-to-EOL fills background without moving cursor).
   */
  private writeLine(content: string): void {
    process.stdout.write(BG + FG + content + EL + RESET);
  }

  /**
   * Draw the highlighted input zone from scratch at the current cursor position.
   * Layout: one highlighted line per wrap; cursor left in the right position.
   */
  private drawBox(prefix: string): void {
    const cols   = this.cols();
    const vpLen  = this.visibleLen(prefix);
    const vpText = this.stripAnsi(prefix);
    // Wrap the visible content to determine line structure
    const inputLines = this.wrap(vpText + this.buffer, cols);

    for (let i = 0; i < inputLines.length; i++) {
      if (i > 0) process.stdout.write('\n');
      // Line 0 uses the actual styled prefix; subsequent lines are pure buffer
      const content = i === 0
        ? prefix + inputLines[0].slice(vpLen)
        : inputLines[i];
      this.writeLine(content);
    }

    this.boxInputLines = inputLines.length;
    this.positionCursor(vpLen, cols, inputLines);
  }

  /**
   * Erase the current highlighted zone and redraw it (after buffer/cursor change).
   */
  private redrawBox(prefix: string): void {
    const cols   = this.cols();
    const vpLen  = this.visibleLen(prefix);
    const vpText = this.stripAnsi(prefix);
    const inputLines = this.wrap(vpText + this.buffer, cols);

    // Move to column 1 of the first input line
    if (this.lastCursorLineInInput > 0) {
      process.stdout.write(`\x1b[${this.lastCursorLineInInput}F`); // CPL n
    } else {
      process.stdout.write('\x1b[1G'); // CHA → col 1 of current line
    }
    process.stdout.write('\x1b[0J'); // clear to end of display

    for (let i = 0; i < inputLines.length; i++) {
      if (i > 0) process.stdout.write('\n');
      const content = i === 0
        ? prefix + inputLines[0].slice(vpLen)
        : inputLines[i];
      this.writeLine(content);
    }

    this.boxInputLines = inputLines.length;
    this.positionCursor(vpLen, cols, inputLines);
  }

  /**
   * Move cursor to the correct position within the highlighted zone.
   * Called after every draw/redraw. Cursor starts at end of last drawn line.
   * vpLen = visible (ANSI-stripped) length of prefix.
   */
  private positionCursor(vpLen: number, cols: number, inputLines: string[]): void {
    const totalBefore = vpLen + this.cursorPos;
    const cursorLine  = Math.floor(totalBefore / cols);
    const cursorCol   = totalBefore % cols;
    // From last drawn line, go up to cursorLine
    const rowsUp = (inputLines.length - 1) - cursorLine;
    if (rowsUp > 0) process.stdout.write(`\x1b[${rowsUp}A`); // CUU
    process.stdout.write(`\x1b[${cursorCol + 1}G`);           // CHA (1-indexed)
    this.lastCursorLineInInput = cursorLine;
  }

  /**
   * Move cursor to new position without redrawing (left/right/home/end).
   */
  private updateCursor(prefix: string): void {
    const cols        = this.cols();
    const vpLen       = this.visibleLen(prefix);
    const totalBefore = vpLen + this.cursorPos;
    const newLine     = Math.floor(totalBefore / cols);
    const newCol      = totalBefore % cols;
    const delta = newLine - this.lastCursorLineInInput;
    if (delta > 0)      process.stdout.write(`\x1b[${delta}B`);    // CUD
    else if (delta < 0) process.stdout.write(`\x1b[${-delta}A`);   // CUU
    process.stdout.write(`\x1b[${newCol + 1}G`);                    // CHA
    this.lastCursorLineInInput = newLine;
  }

  /**
   * On Enter/Ctrl+C: erase the highlighted zone and echo the typed line cleanly.
   */
  private clearBoxAndEcho(prefix: string): void {
    if (this.lastCursorLineInInput > 0) {
      process.stdout.write(`\x1b[${this.lastCursorLineInInput}F`);
    } else {
      process.stdout.write('\x1b[1G');
    }
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
