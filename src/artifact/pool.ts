export interface Pool {
  // Lowers the number of simultaneous jobs for everything that has not started yet.
  limit(concurrency: number): void;
  signal: AbortSignal;
}

// Runs jobs 1..total with at most `concurrency` in flight. The first failure aborts the signal,
// lets the jobs already running settle, and rejects with that first error. Results are returned in
// job order regardless of completion order.
export async function runPool<T>(
  total: number,
  concurrency: number,
  job: (index: number, pool: Pool) => Promise<T>,
): Promise<T[]> {
  const controller = new AbortController();
  const results = new Array<T>(total);
  let allowed = Math.max(1, concurrency);
  let next = 1;
  let active = 0;
  let failure: { error: unknown } | undefined;

  const pool: Pool = {
    limit(value) {
      allowed = Math.max(1, Math.min(allowed, value));
    },
    signal: controller.signal,
  };

  await new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      if (failure) {
        if (active === 0) reject(failure.error);
        return;
      }
      while (active < allowed && next <= total) {
        const index = next++;
        active++;
        job(index, pool).then(
          (value) => {
            results[index - 1] = value;
          },
          (error) => {
            failure ??= { error };
            controller.abort();
          },
        ).finally(() => {
          active--;
          pump();
        });
      }
      if (active === 0 && next > total) resolve();
    };
    pump();
  });
  return results;
}
