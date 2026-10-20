// Flags a worker that repeats the exact same tool call several times in a row.
export class LoopDetector {
  private recent: string[] = [];
  constructor(private threshold = 3) {}
  push(signature: string): boolean {
    this.recent.push(signature);
    if (this.recent.length > this.threshold) this.recent.shift();
    return this.recent.length === this.threshold && this.recent.every((s) => s === signature);
  }
  reset() {
    this.recent = [];
  }
}
