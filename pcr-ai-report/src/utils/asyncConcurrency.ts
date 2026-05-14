/**
 * 类似 Promise.allSettled，但任意时刻最多只有 `concurrency` 个任务在执行。
 * 结果顺序与 `tasks` 一致。用于减轻对 API / Oracle 连接池的突发并发（如 NJS-040）。
 * 各任务返回类型可不同，请在调用处对返回值做元组断言。
 */
export async function allSettledWithConcurrency(
  tasks: readonly (() => Promise<unknown>)[],
  concurrency: number
): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = new Array(tasks.length);
  const limit = Math.max(1, Math.floor(concurrency));
  let cursor = 0;

  async function runOne(i: number): Promise<void> {
    try {
      const value = await tasks[i]();
      results[i] = { status: "fulfilled", value };
    } catch (reason) {
      results[i] = { status: "rejected", reason };
    }
  }

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      await runOne(i);
    }
  }

  const poolSize = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}

/** 列表 + 多聚合同批请求时，对同一连接池的最大并行数（1=完全串行，最省连接） */
export const REPORT_ORACLE_FANOUT_CONCURRENCY = 1;
