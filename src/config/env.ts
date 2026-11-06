import * as fs from 'fs';
import * as path from 'path';
import { HamConfig } from '../types';

const ENV_FILE_NAME = '.env';

/** 环境变量值解析器 */
type EnvParser = (raw: string, name: string) => unknown;

function toInt(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `[ham-config] 环境变量 ${name} 必须是非负整数，收到: ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

function toBool(raw: string, name: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') {
    return false;
  }
  throw new Error(
    `[ham-config] 环境变量 ${name} 必须是布尔值（1/0/true/false/yes/no/on/off），收到: ${JSON.stringify(raw)}`,
  );
}

function toDbType(raw: string, name: string): HamConfig['dbType'] {
  const value = raw.trim().toLowerCase();
  if (value === 'sqlite' || value === 'mysql') return value;
  throw new Error(
    `[ham-config] 环境变量 ${name} 必须是 sqlite 或 mysql，收到: ${JSON.stringify(raw)}`,
  );
}

function toSessionStore(raw: string, name: string): HamConfig['sessionStore'] {
  const value = raw.trim().toLowerCase();
  if (value === 'memory' || value === 'database') return value;
  throw new Error(
    `[ham-config] 环境变量 ${name} 必须是 memory 或 database，收到: ${JSON.stringify(raw)}`,
  );
}

function toLogLevel(raw: string, name: string): HamConfig['logLevel'] {
  const value = raw.trim().toLowerCase();
  const allowed = ['auto', 'trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
  if (allowed.includes(value)) return value as HamConfig['logLevel'];
  throw new Error(
    `[ham-config] 环境变量 ${name} 必须是 ${allowed.join('/')}，收到: ${JSON.stringify(raw)}`,
  );
}

function toLogFormat(raw: string, name: string): HamConfig['logFormat'] {
  const value = raw.trim().toLowerCase();
  if (value === 'auto' || value === 'json' || value === 'pretty') return value;
  throw new Error(
    `[ham-config] 环境变量 ${name} 必须是 auto/json/pretty，收到: ${JSON.stringify(raw)}`,
  );
}

/**
 * 环境变量 -> HamConfig 字段的显式映射。
 *
 * 只支持 `HAM_` 前缀，避免与系统/第三方变量冲突；`PORT` 由 listen() 单独处理，
 * 保持 1.x 的“环境变量优先于 config.port”语义。
 */
const ENV_MAP: Array<{ env: string; key: keyof HamConfig; parse: EnvParser }> = [
  { env: 'HAM_PORT', key: 'port', parse: toInt },
  { env: 'HAM_DEBUG', key: 'debug', parse: toBool },
  { env: 'HAM_LOG_LEVEL', key: 'logLevel', parse: toLogLevel },
  { env: 'HAM_LOG_FORMAT', key: 'logFormat', parse: toLogFormat },
  { env: 'HAM_LOG_REQUESTS', key: 'logRequests', parse: toBool },
  { env: 'HAM_LOG_FILE', key: 'logFile', parse: (v) => v },
  { env: 'HAM_DB_TYPE', key: 'dbType', parse: toDbType },
  { env: 'HAM_SQLITE_PATH', key: 'sqlitePath', parse: (v) => v },
  { env: 'HAM_DB_HOST', key: 'dbHost', parse: (v) => v },
  { env: 'HAM_DB_PORT', key: 'dbPort', parse: toInt },
  { env: 'HAM_DB_NAME', key: 'dbName', parse: (v) => v },
  { env: 'HAM_DB_USER', key: 'dbUser', parse: (v) => v },
  { env: 'HAM_DB_PWD', key: 'dbPwd', parse: (v) => v },
  { env: 'HAM_DB_PREFIX', key: 'dbPrefix', parse: (v) => v },
  { env: 'HAM_DB_CHARSET', key: 'dbCharset', parse: (v) => v },
  { env: 'HAM_DB_CONN_LIMIT', key: 'dbConnLimit', parse: toInt },
  { env: 'HAM_SQL_CACHE_TIME', key: 'sqlCacheTime', parse: toInt },
  { env: 'HAM_SESSION_EXPIRES', key: 'sessionExpires', parse: toInt },
  { env: 'HAM_SESSION_KEY', key: 'sessionKey', parse: (v) => v },
  { env: 'HAM_SESSION_STORE', key: 'sessionStore', parse: toSessionStore },
  { env: 'HAM_SESSION_MAX', key: 'sessionMax', parse: toInt },
  { env: 'HAM_SHUTDOWN_TIMEOUT', key: 'shutdownTimeout', parse: toInt },
  {
    env: 'HAM_SESSION_CLEANUP_INTERVAL',
    key: 'sessionCleanupInterval',
    parse: toInt,
  },
  { env: 'HAM_STATIC_DIR', key: 'staticDir', parse: (v) => v },
  { env: 'HAM_STATIC_MAX_AGE', key: 'staticMaxAge', parse: toInt },
  { env: 'HAM_KEEP_ALIVE_TIMEOUT', key: 'keepAliveTimeout', parse: toInt },
  { env: 'HAM_HEADERS_TIMEOUT', key: 'headersTimeout', parse: toInt },
  { env: 'HAM_REQUEST_TIMEOUT', key: 'requestTimeout', parse: toInt },
  { env: 'HAM_VIEW_DIR', key: 'viewDir', parse: (v) => v },
  { env: 'HAM_VIEW_EXT', key: 'viewExt', parse: (v) => v },
  { env: 'HAM_TEMP_DIR', key: 'tempDir', parse: (v) => v },
  { env: 'HAM_ENABLE_XSS', key: 'enableXss', parse: toBool },
  { env: 'HAM_MAX_BODY_SIZE', key: 'maxBodySize', parse: toInt },
];

/** 读取当前进程环境中显式映射的配置项（未设置或空字符串时跳过） */
export function readEnvConfig(
  env: NodeJS.ProcessEnv = process.env,
): Partial<HamConfig> {
  const config: Partial<HamConfig> = {};
  for (const { env: name, key, parse } of ENV_MAP) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    (config as Record<string, unknown>)[key] = parse(raw, name);
  }
  return config;
}

/**
 * 加载 .env 到 process.env（Node 内置实现，零依赖）。
 *
 * - envFile 为 false：关闭；
 * - envFile 为字符串：相对路径基于 appPath，文件不存在时抛错；
 * - 未指定：依次尝试 `cwd/.env`、`appPath/.env`，加载第一个存在的文件。
 *
 * `process.loadEnvFile` 不会覆盖已存在的真实环境变量，因此真实环境变量优先。
 */
export function loadEnv(
  appPath: string,
  envFile?: string | false,
): string | undefined {
  if (envFile === false) return undefined;

  let file: string | undefined;
  if (envFile !== undefined) {
    file = path.resolve(appPath, envFile);
    if (!fs.existsSync(file)) {
      throw new Error(`[ham-config] 找不到环境变量文件: ${file}`);
    }
  } else {
    file = [
      path.resolve(process.cwd(), ENV_FILE_NAME),
      path.resolve(appPath, ENV_FILE_NAME),
    ].find((candidate) => fs.existsSync(candidate));
  }
  if (!file) return undefined;

  const load = (process as NodeJS.Process & {
    loadEnvFile?: (path?: string) => void;
  }).loadEnvFile;
  if (typeof load !== 'function') {
    throw new Error(
      '[ham-config] 当前 Node 不支持 process.loadEnvFile，请使用 Node >= 22.5 或显式传 envFile: false',
    );
  }
  try {
    load.call(process, file);
  } catch (err) {
    throw new Error(
      `[ham-config] 加载环境变量文件失败 (${file}): ${(err as Error).message}`,
    );
  }
  return file;
}
