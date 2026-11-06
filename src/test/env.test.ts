import 'reflect-metadata';
import { strict as assert } from 'assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HamApplication } from '../application';
import { ConfigService } from '../config/ConfigService';
import { readEnvConfig } from '../config/env';

const MANAGED_ENV = [
  'HAM_DEBUG',
  'HAM_LOG_LEVEL',
  'HAM_LOG_FORMAT',
  'HAM_LOG_REQUESTS',
  'HAM_LOG_FILE',
  'HAM_DB_TYPE',
  'HAM_DB_PORT',
  'HAM_SESSION_STORE',
  'HAM_SESSION_MAX',
  'HAM_SHUTDOWN_TIMEOUT',
  'HAM_ENABLE_XSS',
  'HAM_MAX_BODY_SIZE',
  'HAM_KEEP_ALIVE_TIMEOUT',
];

function clearManagedEnv(): void {
  for (const key of MANAGED_ENV) delete process.env[key];
}

function makeAppPath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ham-env-'));
}

test('env: 加载 .env 并映射为 HamConfig，显式 config 优先', () => {
  const appPath = makeAppPath();
  fs.writeFileSync(
    path.join(appPath, '.env'),
    [
      'HAM_DEBUG=true',
      'HAM_LOG_LEVEL=warn',
      'HAM_LOG_FORMAT=json',
      'HAM_LOG_REQUESTS=true',
      'HAM_LOG_FILE=logs/app.log',
      'HAM_DB_TYPE=mysql',
      'HAM_DB_PORT=3307',
      'HAM_SESSION_MAX=42',
      'HAM_ENABLE_XSS=0',
      'HAM_MAX_BODY_SIZE=2048',
      'HAM_KEEP_ALIVE_TIMEOUT=9000',
    ].join('\n'),
  );

  try {
    const app = new HamApplication({
      appPath,
      envFile: '.env',
      config: { dbName: 'explicit' },
    });
    const cfg = app.container.resolve(ConfigService).config;
    assert.strictEqual(cfg.debug, true);
    assert.strictEqual(cfg.logLevel, 'warn');
    assert.strictEqual(cfg.logFormat, 'json');
    assert.strictEqual(cfg.logRequests, true);
    assert.strictEqual(cfg.logFile, 'logs/app.log');
    assert.strictEqual(cfg.dbType, 'mysql');
    assert.strictEqual(cfg.dbPort, 3307);
    assert.strictEqual(cfg.sessionMax, 42);
    assert.strictEqual(cfg.enableXss, false);
    assert.strictEqual(cfg.maxBodySize, 2048);
    assert.strictEqual(cfg.keepAliveTimeout, 9000);
    assert.strictEqual(cfg.dbName, 'explicit');
  } finally {
    clearManagedEnv();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('env: 真实环境变量优先于 .env，config 参数优先级最高', () => {
  const appPath = makeAppPath();
  fs.writeFileSync(
    path.join(appPath, '.env'),
    ['HAM_DEBUG=true', 'HAM_DB_PORT=3307', 'HAM_SESSION_STORE=database'].join('\n'),
  );
  process.env.HAM_DEBUG = 'false';
  process.env.HAM_DB_PORT = '3308';
  process.env.HAM_SESSION_STORE = 'database';

  try {
    const app = new HamApplication({
      appPath,
      envFile: '.env',
      config: { dbPort: 3309 },
    });
    const cfg = app.container.resolve(ConfigService).config;
    assert.strictEqual(cfg.debug, false); // 真实环境变量覆盖 .env
    assert.strictEqual(cfg.dbPort, 3309); // 显式 config 覆盖环境变量
    assert.strictEqual(cfg.sessionStore, 'database'); // 环境变量映射为 database
  } finally {
    clearManagedEnv();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('env: envFile=false 关闭 .env 加载，但进程环境变量仍会映射', () => {
  const appPath = makeAppPath();
  fs.writeFileSync(path.join(appPath, '.env'), 'HAM_DEBUG=true');
  clearManagedEnv();
  process.env.HAM_SESSION_MAX = '7';

  try {
    const app = new HamApplication({ appPath, envFile: false });
    const cfg = app.container.resolve(ConfigService).config;
    assert.strictEqual(cfg.debug, false); // .env 未加载
    assert.strictEqual(cfg.sessionMax, 7); // 真实环境变量仍生效
  } finally {
    clearManagedEnv();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('env: 默认依次查找 cwd/.env 与 appPath/.env', () => {
  const appPath = makeAppPath();
  fs.writeFileSync(path.join(appPath, '.env'), 'HAM_DEBUG=true');
  const cwd = process.cwd();
  process.chdir(appPath);

  try {
    const app = new HamApplication({ appPath });
    assert.strictEqual(app.container.resolve(ConfigService).get('debug'), true);
  } finally {
    process.chdir(cwd);
    clearManagedEnv();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('env: HAM_SESSION_STORE 非法值给出明确报错', () => {
  assert.throws(() => readEnvConfig({ HAM_SESSION_STORE: 'redis' }), /HAM_SESSION_STORE/);
});

test('env: 日志相关非法值给出明确报错', () => {
  assert.throws(() => readEnvConfig({ HAM_LOG_LEVEL: 'verbose' }), /HAM_LOG_LEVEL/);
  assert.throws(() => readEnvConfig({ HAM_LOG_FORMAT: 'xml' }), /HAM_LOG_FORMAT/);
  assert.throws(() => readEnvConfig({ HAM_LOG_REQUESTS: 'maybe' }), /HAM_LOG_REQUESTS/);
});

test('env: 非法环境变量值给出明确报错', () => {
  assert.throws(
    () => readEnvConfig({ HAM_DB_PORT: 'abc' }),
    /HAM_DB_PORT/,
  );
  assert.throws(
    () => readEnvConfig({ HAM_DB_TYPE: 'postgres' }),
    /HAM_DB_TYPE/,
  );
  assert.throws(
    () => readEnvConfig({ HAM_DEBUG: 'maybe' }),
    /HAM_DEBUG/,
  );
});

test('env: 显式指定的 envFile 不存在时启动报错', () => {
  const appPath = makeAppPath();
  try {
    assert.throws(
      () => new HamApplication({ appPath, envFile: 'missing.env' }),
      /找不到环境变量文件/,
    );
  } finally {
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});
