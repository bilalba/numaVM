import { appendFileSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";

const BENCHMARK_DIR = "/tmp/numavm-bench";
const TIMINGS_FILE = () => `${BENCHMARK_DIR}/internal-timings.jsonl`;

function isBenchmarkEnabled(): boolean {
  return process.env.BENCHMARK_TIMING === "1";
}

interface StepRecord {
  name: string;
  start: number;
  end: number;
  duration_ms: number;
}

export class BenchmarkTimer {
  private steps: StepRecord[] = [];
  private current: { name: string; start: number } | null = null;
  private t0: number;
  private vmId: string;
  private operation: string;
  private enabled: boolean;

  constructor(vmId: string, operation: string) {
    this.vmId = vmId;
    this.operation = operation;
    this.t0 = performance.now();
    this.enabled = isBenchmarkEnabled();
  }

  /** End the previous step (if any) and start a new one. */
  step(name: string): void {
    if (!this.enabled) return;
    const now = performance.now();
    if (this.current) {
      this.steps.push({
        name: this.current.name,
        start: this.current.start,
        end: now,
        duration_ms: Math.round((now - this.current.start) * 100) / 100,
      });
    }
    this.current = { name, start: now };
  }

  /** End the current step without starting a new one. */
  endStep(): void {
    if (!this.enabled) return;
    const now = performance.now();
    if (this.current) {
      this.steps.push({
        name: this.current.name,
        start: this.current.start,
        end: now,
        duration_ms: Math.round((now - this.current.start) * 100) / 100,
      });
      this.current = null;
    }
  }

  /** Finalize timing and write to JSONL file. Returns the record for inspection. */
  finish(): { vmId: string; operation: string; steps: { name: string; duration_ms: number }[]; total_ms: number; ts: string } | null {
    if (!this.enabled) return null;

    // End any in-progress step
    this.endStep();

    const total_ms = Math.round((performance.now() - this.t0) * 100) / 100;
    const record = {
      vmId: this.vmId,
      operation: this.operation,
      steps: this.steps.map((s) => ({ name: s.name, duration_ms: s.duration_ms })),
      total_ms,
      ts: new Date().toISOString(),
    };

    try {
      mkdirSync(BENCHMARK_DIR, { recursive: true });
      appendFileSync(TIMINGS_FILE(), JSON.stringify(record) + "\n");
    } catch (err) {
      console.warn(`[benchmark-timer] Failed to write timing data: ${err}`);
    }

    return record;
  }
}
