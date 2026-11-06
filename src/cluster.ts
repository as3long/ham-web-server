/**
 * 内置多进程启动与 PM2 兼容工具。
 *
 * - `runCluster(bootstrap, options)`：在非 PM2 环境下通过 Node cluster 启动多个 worker；
 *    PM2 管理的进程或已是 cluster worker 时直接执行 bootstrap，由 PM2 负责 fork。
 * - `isManagedProcess(env)`：判断当前是否由 PM2 管理（`pm_id` 或 `NODE_APP_INSTANCE`）。
 * - `isMultiProcessRuntime(env)`：判断当前是否运行在多进程环境。
 *
 * 框架不接管 PM2 的 fork，只负责生命周期、就绪通知和共享会话。
 */
type ClusterWorker = {
  id: number;
  kill(signal?: string): void;
  on(event: string, listener: (...args: any[]) => void): void;
  removeListener(event: string, listener: (...args: any[]) => void): void;
};

const cluster = require('cluster') as {
  isWorker: boolean;
  schedulingPolicy: number | undefined;
  SCHED_RR: number;
  fork(): ClusterWorker;
  on(event: string, listener: (...args: any[]) => void): void;
};
import * as net from 'net';

/** 内置 cluster 的选项 */
export interface ClusterOptions {
  /** 工作进程数量：默认 WORKERS / HAM_WORKERS / WEB_CONCURRENCY，再回退 1 */
  workers?: number;
  /** 工作进程异常退出后的重启延迟（毫秒），默认 1000 */
  restartDelay?: number;
  /** 主进程等待所有 worker 退出的上限（毫秒），默认 12000 */
  shutdownTimeout?: number;
}

/** 判断当前是否由 PM2 管理 */
export function isManagedProcess(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !!env.pm_id || !!env.NODE_APP_INSTANCE;
}

/** 判断当前是否运行在多进程环境 */
export function isMultiProcessRuntime(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isManagedProcess(env)) return true;
  if (cluster.isWorker) return true;
  try {
    return (
      Number(env.WORKERS ?? env.WEB_CONCURRENCY ?? 0) > 1 ||
      Number(env.pm_id ?? 0) > 0
    );
  } catch {
    return false;
  }
}

/**
 * 判断当前进程是否应承担“只执行一次”的任务。
 *
 * - PM2 cluster 模式（NODE_APP_INSTANCE 已设置）：仅实例 0 返回 true；
 * - PM2 fork 模式（未设置 NODE_APP_INSTANCE）：本应用唯一进程，返回 true；
 * - 内置 cluster：主进程（非 worker）返回 true；
 * - 单进程：返回 true。
 *
 * 注意：PM2 实例 0 重启时任务会再次执行，“选进程”不等于“恰好一次”，
 * 任务本身仍需幂等或加锁。
 */
export function isPrimaryProcess(): boolean {
  if (isManagedProcess()) {
    const instance = process.env.NODE_APP_INSTANCE;
    if (instance !== undefined) return instance === '0';
    return true;
  }
  return !cluster.isWorker;
}

/**
 * 仅在“主进程”执行一次任务：非主进程直接跳过并返回 undefined。
 *
 * 典型用途：定时任务、缓存预热、数据迁移、监听端口外的后台工作。
 * 注意返回值语义：非主进程返回 undefined，与任务本身返回 undefined
 * 无法区分；需要区分时请先自行调用 `isPrimaryProcess()`。
 */
export async function runOnce<T>(
  task: () => T | Promise<T>,
): Promise<T | undefined> {
  if (!isPrimaryProcess()) return undefined;
  return await task();
}

/** 解析工作进程数量 */
function resolveWorkers(options: ClusterOptions): number {
  if (options.workers !== undefined) return Math.max(1, options.workers);
  try {
    const fromEnv =
      Number(process.env.WORKERS ?? process.env.WEB_CONCURRENCY ?? 0);
    if (fromEnv > 1) return fromEnv;
  } catch {
    /* 忽略 */
  }
  return 1;
}

/** 解析重启延迟（毫秒） */
function resolveRestartDelay(options: ClusterOptions): number {
  return options.restartDelay ?? 1000;
}

/** 解析主进程关闭等待上限（毫秒） */
function resolveShutdownTimeout(options: ClusterOptions): number {
  return options.shutdownTimeout ?? 12000;
}

/**
 * 启动多进程应用。
 *
 * - 如果由 PM2 管理（`pm_id`/`NODE_APP_INSTANCE`）或已经是 cluster worker，
 *   直接 `await bootstrap()`，不再 fork；由 PM2 负责多实例。
 * - 否则解析 worker 数量，<=1 时直接 bootstrap；>1 时主进程 fork N 个 worker，
 *   转发 SIGINT/SIGTERM，异常退出按延迟重启，关闭时强杀超时 worker。
 */
export async function runCluster(
  bootstrap: () => Promise<void> | void,
  options: ClusterOptions = {},
): Promise<void> {
  if (isManagedProcess()) {
    await bootstrap();
    return;
  }
  if (cluster.isWorker) {
    await bootstrap();
    return;
  }

  const workers = resolveWorkers(options);
  if (workers <= 1) {
    await bootstrap();
    return;
  }

  if (!process.argv[1]) {
    throw new Error(
      '[ham-cluster] 无法在 REPL 或 eval 模式下启动多进程，请将 bootstrap 放入文件中运行。',
    );
  }

  // 轮询分发请求（Windows/macOS/Linux 均可用时优先）
  if (
    cluster.schedulingPolicy !== undefined &&
    cluster.SCHED_RR !== undefined
  ) {
    cluster.schedulingPolicy = cluster.SCHED_RR;
  }

  let shuttingDown = false;
  const workerExitHandlers = new Set<() => void>();
  const workersMap = new Map<number, ClusterWorker>();

  const forkWorker = (): ClusterWorker => {
    const worker = cluster.fork();
    workersMap.set(worker.id, worker);

    const onExit = (code: number | null, signal: string | null) => {
      workersMap.delete(worker.id);
      if (shuttingDown) return;
      if (code === 0 && signal === null) return; // 正常退出，不重启
      setTimeout(forkWorker, resolveRestartDelay(options));
    };
    worker.on('exit', onExit);
    workerExitHandlers.add(() => worker.removeListener('exit', onExit));
    return worker;
  };

  for (let i = 0; i < workers; i++) {
    forkWorker();
  }

  const stop = (signal: NodeJS.Signals): void => {
    shuttingDown = true;
    for (const worker of workersMap.values()) {
      try {
        worker.kill(signal);
      } catch {
        /* 忽略 */
      }
    }
  };

  const onSignal = () => {
    stop('SIGTERM');
    setTimeout(() => {
      stop('SIGKILL');
    }, resolveShutdownTimeout(options));
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  if (process.platform === 'win32') {
    process.on('SIGBREAK', onSignal);
  }

  try {
    // 等待所有 worker 退出
    await new Promise<void>((resolve) => {
      const check = () => {
        if (workersMap.size === 0) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  } finally {
    for (const remove of workerExitHandlers) remove();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (process.platform === 'win32') {
      process.off('SIGBREAK', onSignal);
    }
  }
}

/** 简易 HTTP 健康检查：轮询直到端口可连接 */
export async function waitForPort(
  port: number,
  options: { host?: string; timeout?: number; interval?: number } = {},
): Promise<void> {
  const host = options.host ?? '127.0.0.1';
  const timeout = options.timeout ?? 15000;
  const interval = options.interval ?? 100;
  const deadline = Date.now() + timeout;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new net.Socket();
        socket.setTimeout(interval);
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', (err) => {
          lastErr = err;
          socket.destroy();
        });
        socket.once('timeout', () => {
          socket.destroy();
        });
        socket.connect(port, host);
      });
      return;
    } catch {
      /* 重试 */
    }
    await sleep(interval);
  }
  throw lastErr ?? new Error(`[ham-cluster] 端口 ${port} 在 ${timeout}ms 内未可用`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
