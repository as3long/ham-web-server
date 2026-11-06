import { MINUTE_MS, SECOND_MS } from './constants';

/** 构造函数类型 */
export type Type<T> = new (...args: any[]) => T;

/** 依赖注入的令牌：类构造器、字符串或 Symbol */
export type Token<T = any> = Type<T> | string | symbol;

/** 生命周期作用域 */
export type Scope = 'singleton' | 'transient' | 'request';

/** 上传的文件（已归一化） */
export interface UploadedFile {
  /** 临时文件路径 */
  tmpPath: string;
  /** 原始文件名 */
  originalName: string;
  /** 文件大小（字节） */
  size: number;
  /** MIME 类型 */
  type: string;
}

/** 解析后的请求体 */
export interface PostData {
  fields: Record<string, string>;
  files: Record<string, UploadedFile>;
}

/** 会话对象 */
export interface Session {
  id: string;
  /** 过期时间戳（毫秒） */
  expire: number;
  /** 会话数据（直接读写） */
  data: Record<string, any>;
}

/** 框架配置 */
export interface HamConfig {
  /** 监听端口（可被环境变量 PORT 覆盖） */
  port: number;
  /** 调试模式：输出调试日志、500 返回堆栈、关闭模板缓存 */
  debug: boolean;
  /**
   * 日志级别：
   * - auto：debug=true 时为 debug，否则 info
   * - silent：关闭日志
   */
  logLevel:
    | 'auto'
    | 'trace'
    | 'debug'
    | 'info'
    | 'warn'
    | 'error'
    | 'fatal'
    | 'silent';
  /**
   * 日志格式：
   * - auto：debug=true 时为 pretty，否则 json
   * - 设置 logFile 时强制 json
   */
  logFormat: 'auto' | 'json' | 'pretty';
  /** 是否输出 HTTP 访问日志 */
  logRequests: boolean;
  /** 日志文件路径（相对 appPath；为空时输出到 stdout） */
  logFile: string;
  /** 数据库类型 */
  dbType: 'sqlite' | 'mysql';
  /** SQLite 数据库文件路径（相对路径时基于 appPath 解析） */
  sqlitePath: string;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPwd: string;
  /** 数据库表前缀 */
  dbPrefix: string;
  dbCharset: string;
  dbConnLimit: number;
  /** 查询缓存时间（毫秒），配合 .cache() 使用 */
  sqlCacheTime: number;
  /** 会话有效期（毫秒） */
  sessionExpires: number;
  /** 会话 Cookie 名称 */
  sessionKey: string;
  /**
   * 会话存储：
   * - memory：进程内 Map（默认，单进程最快）
   * - database：写入数据库，多进程/PM2 cluster 下共享会话
   */
  sessionStore: 'memory' | 'database';
  /** 内存会话数量上限（按插入顺序做 LRU，超限淘汰最旧；database 存储忽略） */
  sessionMax: number;
  /** 过期会话清理周期（毫秒） */
  sessionCleanupInterval: number;
  /** 优雅关闭等待上限（毫秒） */
  shutdownTimeout: number;
  /** 静态资源目录（相对于 appPath） */
  staticDir: string;
  /** 静态资源 Cache-Control max-age（毫秒） */
  staticMaxAge: number;
  /** HTTP keep-alive 超时（毫秒） */
  keepAliveTimeout: number;
  /** HTTP 请求头超时（毫秒，必须大于 keepAliveTimeout） */
  headersTimeout: number;
  /** HTTP 请求总超时（毫秒） */
  requestTimeout: number;
  /** 视图目录（相对于 appPath） */
  viewDir: string;
  /** 视图文件扩展名 */
  viewExt: string;
  /** 上传临时目录（相对于 appPath） */
  tempDir: string;
  /** 是否对表单字段做 XSS 过滤 */
  enableXss: boolean;
  /** 请求体大小上限（字节） */
  maxBodySize: number;
}

export const DEFAULT_CONFIG: HamConfig = {
  port: 3000,
  debug: false,
  logLevel: 'auto',
  logFormat: 'auto',
  logRequests: false,
  logFile: '',
  dbType: 'sqlite',
  sqlitePath: 'ham.sqlite',
  dbHost: 'localhost',
  dbPort: 3306,
  dbName: 'nodejs',
  dbUser: 'root',
  dbPwd: '',
  dbPrefix: 'ham_',
  dbCharset: 'utf8mb4',
  dbConnLimit: 5,
  sqlCacheTime: 10 * MINUTE_MS,
  sessionExpires: 30 * MINUTE_MS,
  sessionKey: 'ham_session_id',
  sessionStore: 'memory',
  sessionMax: 10000,
  sessionCleanupInterval: MINUTE_MS,
  shutdownTimeout: 10 * SECOND_MS,
  staticDir: 'static',
  staticMaxAge: 2 * MINUTE_MS,
  keepAliveTimeout: 65 * SECOND_MS,
  headersTimeout: 66 * SECOND_MS,
  requestTimeout: 30 * SECOND_MS,
  viewDir: 'views',
  viewExt: '.html',
  tempDir: '.ham-temp',
  enableXss: true,
  maxBodySize: 10 * 1024 * 1024,
};
