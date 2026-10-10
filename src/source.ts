/** A source file with fast offset → line/column lookup. */
export class SourceFile {
  readonly name: string;
  readonly text: string;
  /** Offset at which each line starts. */
  private readonly lineStarts: number[] = [0];

  constructor(name: string, text: string) {
    this.name = name;
    this.text = text;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') this.lineStarts.push(i + 1);
    }
  }

  /** 1-based line and column of a character offset. */
  position(offset: number): { line: number; column: number } {
    let low = 0;
    let high = this.lineStarts.length - 1;

    while (low < high) {
      const mid = (low + high + 1) >> 1;

      if (this.lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }

    return { line: low + 1, column: offset - this.lineStarts[low]! + 1 };
  }

  /** Text of a 1-based line, without the line break. */
  lineText(line: number): string {
    const start = this.lineStarts[line - 1] ?? this.text.length;
    const end = this.lineStarts[line] ?? this.text.length;

    return this.text.slice(start, end).replace(/\r?\n$/, '');
  }
}
