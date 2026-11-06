import 'reflect-metadata';
import { strict as assert } from 'assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Writable } from 'stream';
import { HamApplication } from '../application';
import { BaseController } from '../controller/BaseController';
import { Controller, Injectable } from '../container/decorators';
import { Context } from '../core/Context';
import { ConfigService } from '../config/ConfigService';
import { Logger, LoggerLike, LogFn } from '../logging/Logger';

interface LogEntry {
  level: string;
  msg?: string;
  [key: string]: unknown;
}

/** 捕获式 logger，用于断言应用内部日志调用 */
class CaptureLogger implements LoggerLike {
  constructor(
    private readonly sink: LogEntry[],
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  private record(level: string, args: unknown[]): void {
    const entry: LogEntry = { level, ...this.bindings };
    const first = args[0];
    if (typeof first === 'string') {
      entry.msg = first;
    } else if (first && typeof first === 'object') {
      Object.assign(entry, first);
      if (typeof args[1] === 'string') entry.msg = args[1];
    }
    this.sink.push(entry);
  }

  trace: LogFn = (...args: unknown[]) => this.record('trace', args);
  debug: LogFn = (...args: unknown[]) => this.record('debug', args);
  info: LogFn = (...args: unknown[]) => this.record('info', args);
  warn: LogFn = (...args: unknown[]) => this.record('warn', args);
  error: LogFn = (...args: unknown[]) => this.record('error', args);
  fatal: LogFn = (...args: unknown[]) => this.record('fatal', args);

  child(bindings: Record<string, unknown>): LoggerLike {
    return new CaptureLogger(this.sink, { ...this.bindings, ...bindings });
  }
}

function makeAppPath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ham-log-'));
}

function makeLogCapture(): { stream: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, chunks };
}

function parseLines(chunks: string[]): any[] {
  return chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

@Controller('log-test')
class LogTestController extends BaseController {
  constructor(ctx: Context) {
    super(ctx);
  }

  async indexAction() {
    return { requestId: this.ctx.requestId };
  }

  async failAction() {
    throw new Error('BOOM-LOG-MARKER');
  }
}

@Injectable()
class LogConsumer {
  constructor(readonly logger: Logger) {}
}

test('Logger: 级别过滤、child 绑定与敏感字段脱敏', () => {
  const { stream, chunks } = makeLogCapture();
  const logger = new Logger(
    new ConfigService({ logLevel: 'debug', logFormat: 'json' }),
    os.tmpdir(),
    stream as any,
  );

  logger.debug({ password: 'secret-password', cookie: 'sid=secret-cookie' }, 'debug-msg');
  logger.child({ module: 'order' }).info('child-msg');
  logger.flush();

  const lines = parseLines(chunks);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].level, 'debug');
  assert.equal(lines[0].password, '[REDACTED]');
  assert.equal(lines[0].cookie, '[REDACTED]');
  assert.equal(lines[1].module, 'order');
  assert.equal(lines[1].msg, 'child-msg');
});

test('Logger: silent 与 error 级别过滤', () => {
  const silent = makeLogCapture();
  const silentLogger = new Logger(
    new ConfigService({ logLevel: 'silent', logFormat: 'json' }),
    os.tmpdir(),
    silent.stream as any,
  );
  silentLogger.info('hidden');
  silentLogger.flush();
  assert.equal(silent.chunks.join(''), '');

  const errorOnly = makeLogCapture();
  const errorLogger = new Logger(
    new ConfigService({ logLevel: 'error', logFormat: 'json' }),
    os.tmpdir(),
    errorOnly.stream as any,
  );
  errorLogger.info('hidden');
  errorLogger.error(new Error('BOOM-ERROR'));
  errorLogger.flush();
  const lines = parseLines(errorOnly.chunks);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'error');
  assert.equal(lines[0].err.message, 'BOOM-ERROR');
});

test('Logger: 文件输出在 close 后可见', async () => {
  const appPath = makeAppPath();
  try {
    const logger = new Logger(
      new ConfigService({
        logLevel: 'info',
        logFormat: 'json',
        logFile: path.join('logs', 'app.log'),
      }),
      appPath,
    );
    logger.info({ hello: 'file' }, 'file-msg');
    await logger.close();

    const file = path.join(appPath, 'logs', 'app.log');
    let content = '';
    for (let i = 0; i < 10 && !content; i++) {
      if (fs.existsSync(file)) content = fs.readFileSync(file, 'utf8');
      if (!content) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(content.includes('file-msg'));
    assert.ok(content.includes('"hello":"file"'));
  } finally {
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('HamApplication: 请求 ID、访问日志与错误日志', async () => {
  const appPath = makeAppPath();
  const app = new HamApplication({
    appPath,
    config: { logRequests: true, logLevel: 'info', logFormat: 'json' },
  });
  const entries: LogEntry[] = [];
  app.setLogger(new CaptureLogger(entries));
  app.addController(LogTestController);

  const server = await app.listen(0);
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${base}/log-test/`, {
      headers: { 'X-Request-Id': 'client-request-1' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-request-id'), 'client-request-1');
    const body = (await res.json()) as any;
    assert.equal(body.requestId, 'client-request-1');

    const generated = await fetch(`${base}/log-test/`);
    const generatedId = generated.headers.get('x-request-id');
    assert.ok(generatedId);
    assert.notEqual(generatedId, 'client-request-1');

    const access = entries.find(
      (entry) => entry.msg === '请求完成' && entry.status === 200,
    );
    assert.ok(access);
    assert.equal(access!.level, 'info');
    assert.equal(access!.requestId, 'client-request-1');

    const missing = await fetch(`${base}/log-test/nope`);
    assert.equal(missing.status, 404);
    const missingAccess = entries.find(
      (entry) => entry.msg === '请求完成' && entry.status === 404,
    );
    assert.ok(missingAccess);
    assert.equal(missingAccess!.level, 'warn');

    const fail = await fetch(`${base}/log-test/fail`);
    assert.equal(fail.status, 500);
    const errorLog = entries.find((entry) => entry.msg === '请求处理失败');
    assert.ok(errorLog);
    assert.equal(errorLog!.level, 'error');
    assert.ok((errorLog!.err as any)?.stack?.includes('BOOM-LOG-MARKER'));
    const failAccess = entries.find(
      (entry) => entry.msg === '请求完成' && entry.status === 500,
    );
    assert.ok(failAccess);
    assert.equal(failAccess!.level, 'error');
  } finally {
    await app.close();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('HamApplication: logRequests=false 不产生访问日志', async () => {
  const appPath = makeAppPath();
  const app = new HamApplication({
    appPath,
    config: { logRequests: false, logLevel: 'info', logFormat: 'json' },
  });
  const entries: LogEntry[] = [];
  app.setLogger(new CaptureLogger(entries));
  app.addController(LogTestController);

  const server = await app.listen(0);
  const port = (server.address() as any).port;
  try {
    await fetch(`http://127.0.0.1:${port}/log-test/`);
    assert.equal(entries.some((entry) => entry.msg === '请求完成'), false);
  } finally {
    await app.close();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('HamApplication: Logger 可注入，自定义 logger 可替换', () => {
  const appPath = makeAppPath();
  try {
    const capture = new CaptureLogger([]);
    const app = new HamApplication({ appPath });
    app.setLogger(capture);
    assert.equal(app.logger, capture);

    app.register(LogConsumer);
    const consumer = app.container.resolve(LogConsumer);
    assert.equal(consumer.logger, capture);

    const optionsApp = new HamApplication({ appPath, logger: capture });
    assert.equal(optionsApp.logger, capture);
  } finally {
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});
