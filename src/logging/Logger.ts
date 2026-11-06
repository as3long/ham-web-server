import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import pino from 'pino';
import { ConfigService } from '../config/ConfigService';

/** 日志级别；auto 由 debug 配置决定 */
export type LogLevel =
  | 'auto'
  | 'trace'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'fatal'
  | 'silent';

/** pino 风格的日志函数（对象 + 消息，或纯消息） */
export interface LogFn {
  (obj: unknown, msg?: string, ...args: unknown[]): void;
  (msg: string, ...args: unknown[]): void;
}

/** 可替换的日志器接口；自定义实现只需满足这些方法 */
export interface LoggerLike {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  child(bindings: Record<string, unknown>): LoggerLike;
  flush?(cb?: () => void): void;
  close?(): void | Promise<void>;
}

/** 默认脱敏字段；同时覆盖嵌套对象与请求头形式 */
const DEFAULT_REDACT_PATHS = [
  'password',
  'passwordHash',
  'salt',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  '*.password',
  '*.passwordHash',
  '*.salt',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.authorization',
  '*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
];

/**
 * 框架日志器（pino 封装）。
 *
 * - 默认 stdout JSON；`logFormat=pretty` 时使用 pino-pretty；
 * - `logFile` 非空时写入文件（强制 JSON），目录不存在会自动创建；
 * - 支持 child bindings、敏感字段脱敏、错误堆栈序列化；
 * - `close()` 幂等，应用优雅退出时 flush 并关闭自建文件流。
 */
export class Logger implements LoggerLike {
  private readonly pino: pino.Logger;
  private readonly ownedDestination?: pino.DestinationStream;
  private closed = false;

  constructor(
    private readonly config: ConfigService,
    private readonly appPath: string,
    destination?: pino.DestinationStream,
  ) {
    const cfg = this.config.config;
    const level = resolveLevel(cfg.logLevel, cfg.debug);
    const format = resolveFormat(cfg.logFormat, cfg.debug);
    const options: pino.LoggerOptions = {
      level,
      base: {
        service: 'ham',
        pid: process.pid,
        hostname: os.hostname(),
        worker:
          process.env.NODE_APP_INSTANCE ??
          process.env.pm_id ??
          'single',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
      redact: {
        paths: DEFAULT_REDACT_PATHS,
        censor: '[REDACTED]',
      },
    };

    if (destination) {
      this.pino = pino(options, destination);
      return;
    }

    if (cfg.logFile) {
      const file = path.resolve(this.appPath, cfg.logFile);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fileDestination = pino.destination({ dest: file, sync: false });
      this.pino = pino(options, fileDestination);
      this.ownedDestination = fileDestination;
      return;
    }

    if (format === 'pretty') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const prettyFactory = require('pino-pretty') as (opts?: unknown) => NodeJS.WritableStream;
        const prettyStream = prettyFactory({
          colorize: process.stdout.isTTY === true,
          translateTime: 'SYS:standard',
          singleLine: true,
          ignore: 'pid,hostname',
        });
        this.pino = pino(options, prettyStream);
      } catch (err) {
        console.warn(
          `[ham-log] pino-pretty 加载失败，回退 JSON 日志: ${(err as Error)?.message ?? String(err)}`,
        );
        this.pino = pino(options);
      }
      return;
    }

    this.pino = pino(options);
  }

  trace: LogFn = (...args: unknown[]) => {
    (this.pino.trace as (...a: unknown[]) => void)(...normalizeArgs(args));
  };

  debug: LogFn = (...args: unknown[]) => {
    (this.pino.debug as (...a: unknown[]) => void)(...normalizeArgs(args));
  };

  info: LogFn = (...args: unknown[]) => {
    (this.pino.info as (...a: unknown[]) => void)(...normalizeArgs(args));
  };

  warn: LogFn = (...args: unknown[]) => {
    (this.pino.warn as (...a: unknown[]) => void)(...normalizeArgs(args));
  };

  error: LogFn = (...args: unknown[]) => {
    (this.pino.error as (...a: unknown[]) => void)(...normalizeArgs(args));
  };

  fatal: LogFn = (...args: unknown[]) => {
    (this.pino.fatal as (...a: unknown[]) => void)(...normalizeArgs(args));
  };

  child(bindings: Record<string, unknown>): LoggerLike {
    return this.pino.child(bindings) as unknown as LoggerLike;
  }

  flush(cb?: () => void): void {
    this.pino.flush(cb);
  }

  /** 幂等关闭：flush 后结束自建文件流；不关闭 stdout/外部传入流 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    await new Promise<void>((resolve) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      // flush 回调在极端情况下可能不触发，兜底避免关闭流程卡死
      timer = setTimeout(finish, 1000);
      timer.unref?.();
      try {
        this.pino.flush(finish);
      } catch {
        finish();
      }
    });

    try {
      (this.ownedDestination as unknown as { end?: () => void })?.end?.();
    } catch {
      /* 忽略关闭文件流失败 */
    }
  }
}

function resolveLevel(
  configured: LogLevel,
  debug: boolean,
): Exclude<LogLevel, 'auto'> {
  if (configured === 'auto') return debug ? 'debug' : 'info';
  return configured;
}

function resolveFormat(
  configured: 'auto' | 'json' | 'pretty',
  debug: boolean,
): 'json' | 'pretty' {
  if (configured === 'auto') return debug ? 'pretty' : 'json';
  return configured;
}

/** 首参为 Error 时转成 pino 的 `{ err }`，确保 stack 被序列化 */
function normalizeArgs(args: unknown[]): unknown[] {
  if (args.length > 0 && args[0] instanceof Error) {
    return [{ err: args[0] }, ...args.slice(1)];
  }
  return args;
}
