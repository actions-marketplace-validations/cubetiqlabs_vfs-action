import { describe, expect, it } from 'bun:test';
import { describeFailure } from '../src/artifact/common';
import { runPool } from '../src/artifact/pool';

const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runPool', () => {
  it('never runs more jobs than the concurrency and returns results in job order', async () => {
    let active = 0;
    let peak = 0;
    const results = await runPool(9, 3, async (index) => {
      active++;
      peak = Math.max(peak, active);
      await tick(index % 2 ? 6 : 2);
      active--;
      return index * 10;
    });
    expect(peak).toBe(3);
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  it('stops starting jobs after a failure, aborts the rest and waits for them to settle', async () => {
    const started: number[] = [];
    let settled = 0;
    let aborted = false;
    const failure = runPool(10, 3, async (index, pool) => {
      started.push(index);
      try {
        if (index === 2) throw new Error('part 2 failed');
        await new Promise<void>((resolve) => {
          pool.signal.addEventListener('abort', () => { aborted = true; resolve(); });
          setTimeout(resolve, 200);
        });
      } finally {
        settled++;
      }
    });
    await expect(failure).rejects.toThrow('part 2 failed');
    expect(aborted).toBe(true);
    expect(settled).toBe(started.length);
    expect(started.length).toBeLessThan(10);
  });

  it('runs one job at a time after the limit is lowered', async () => {
    let active = 0;
    const concurrencyWhenStarted: number[] = [];
    await runPool(8, 4, async (index, pool) => {
      active++;
      concurrencyWhenStarted[index - 1] = active;
      if (index === 1) pool.limit(1);
      await tick(5);
      active--;
    });
    // Jobs 1-4 were already running; each later job starts alone.
    expect(concurrencyWhenStarted.slice(4)).toEqual([1, 1, 1, 1]);
  });
});

describe('describeFailure', () => {
  it('replaces a proxy error page with one line', () => {
    const page = '<!DOCTYPE html>\n<html><head><title>cubis.tech | 524: A timeout occurred</title></head></html>';
    expect(describeFailure(524, page)).toBe('HTTP 524 (the origin did not answer in time)');
    expect(describeFailure(502, '')).toBe('HTTP 502 (bad gateway)');
  });

  it('keeps a server message and bounds its length', () => {
    expect(describeFailure(413, 'upload size exceeds limit')).toBe('HTTP 413: upload size exceeds limit');
    expect(describeFailure(500, 'x'.repeat(500)).length).toBeLessThan(230);
    expect(describeFailure(0, 'connect ECONNRESET')).toBe('connect ECONNRESET');
  });
});
