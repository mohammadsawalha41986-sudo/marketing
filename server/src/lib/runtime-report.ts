/**
 * What this process is actually allowed to use.
 *
 * On shared hosting the Rust query engine panics with `PANIC: timer has gone
 * away` when it cannot spawn its timer thread, which happens when the account's
 * process/thread allowance is exhausted. That failure is invisible from the
 * Prisma error alone — it names the symptom, never the budget — so the numbers
 * that decide it are printed at startup and again once the engine is up.
 *
 * Everything here is read from /proc and `os`, costs nothing, and is safe to
 * print: no credentials, no connection string, no paths outside this process.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';

/** Threads currently owned by this process, or null off Linux. */
export function threadCount(): number | null {
  try {
    const status = readFileSync('/proc/self/status', 'utf8');
    const line = status.split('\n').find((entry) => entry.startsWith('Threads:'));
    const value = Number(line?.split(/\s+/)[1]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** The kernel's `nproc` ceiling for this user, which is what a host caps. */
function processLimit(): { soft: string; hard: string } | null {
  try {
    const limits = readFileSync('/proc/self/limits', 'utf8');
    const line = limits.split('\n').find((entry) => entry.startsWith('Max processes'));
    if (!line) return null;
    // Columns are fixed-width: "Max processes  <soft>  <hard>  processes".
    const parts = line.replace('Max processes', '').trim().split(/\s+/);
    const soft = parts[0];
    const hard = parts[1];
    return soft && hard ? { soft, hard } : null;
  } catch {
    return null;
  }
}

/**
 * The startup block. Every line exists to make one specific failure diagnosable
 * rather than to pad the log.
 */
export function runtimeReport(): string[] {
  const cpus = os.availableParallelism?.() ?? os.cpus().length;
  const limit = processLimit();
  const threads = threadCount();

  const lines = [
    `  cpus visible   ${cpus}  (v8 pool, prisma workers and its default pool all scale from this)`,
    `  threads now    ${threads ?? 'unknown'}`,
  ];

  if (limit) {
    lines.push(`  max processes  soft ${limit.soft} / hard ${limit.hard}  (counts threads too)`);

    const soft = Number(limit.soft);
    // The engine needs roughly a thread per CPU plus its timer thread. If the
    // ceiling is not comfortably above what one process already wants, the
    // panic is a question of when, not whether — say so before it happens.
    if (Number.isFinite(soft) && threads !== null && soft < threads + cpus + 8) {
      lines.push(
        '',
        '  WARNING — this process is close to the host process/thread ceiling.',
        '  The Prisma query engine spawns a timer thread when it starts; if that',
        '  spawn fails it panics with "PANIC: timer has gone away". Lower the',
        '  thread demand (see --v8-pool-size and DATABASE_CONNECTION_LIMIT in the',
        '  README) or stop other processes on the account.',
      );
    }
  }

  return lines;
}
