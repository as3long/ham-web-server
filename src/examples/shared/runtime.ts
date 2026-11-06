/**
 * 示例应用共享启动运行时。
 *
 * - `exampleSessionStore()`：单进程默认 memory；PM2 / Node cluster / WORKERS>1
 *   时自动切换 database（会话跨 worker 共享）；可用 HAM_SESSION_STORE 显式覆盖。
 * - `runExample(bootstrap)`：用 `runCluster` 包装示例启动；PM2 环境下直接 bootstrap，
 *   由 PM2 负责 fork；非 PM2 且 WORKERS>1 时使用内置 cluster。
 */
import { isMultiProcessRuntime, runCluster } from '../../cluster';

export function exampleSessionStore(): 'memory' | 'database' {
  const fromEnv = process.env.HAM_SESSION_STORE;
  if (fromEnv === 'memory' || fromEnv === 'database') return fromEnv;
  return isMultiProcessRuntime() ? 'database' : 'memory';
}

/** 示例默认开启访问日志；脚本/压测可用 HAM_LOG_REQUESTS=0 关闭 */
export function exampleLogRequests(): boolean {
  const raw = process.env.HAM_LOG_REQUESTS;
  if (raw === undefined || raw === '') return true;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

export async function runExample(
  bootstrap: () => Promise<void>,
  options?: { workers?: number },
): Promise<void> {
  await runCluster(bootstrap, {
    workers: options?.workers,
  });
}
