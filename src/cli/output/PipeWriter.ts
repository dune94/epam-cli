import process from 'process';

export class PipeWriter {
  private buffer = '';

  write(text: string): void {
    this.buffer += text;
  }

  flush(): void {
    if (this.buffer) {
      process.stdout.write(this.buffer);
      this.buffer = '';
    }
  }

  writeLine(text: string): void {
    process.stdout.write(text + '\n');
  }

  finalize(): void {
    this.flush();
    if (this.buffer && !this.buffer.endsWith('\n')) {
      process.stdout.write('\n');
    }
  }
}
