/**
 * 数据库驱动接口。参数统一使用 "?" 占位符。
 */
export interface ExecResult {
  /** 自增主键值 */
  insertId: number;
  /** 受影响行数 */
  affectedRows: number;
}

/** SQLite 预处理语句缓存上限 */
const STMT_CACHE_SIZE = 256;
/** SQLite 并发写等待时间（毫秒） */
const BUSY_TIMEOUT_MS = 5000;

export interface DbDriver {
  readonly dialect: 'sqlite' | 'mysql';
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<ExecResult>;
  /** 执行 DDL 或多条语句 */
  exec(sql: string, params?: unknown[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * SQLite 驱动：优先使用 Node.js 内置 node:sqlite（>=22.5，无原生依赖），
 * 不可用时回退到 better-sqlite3（可选依赖）。
 */
export class SqliteDriver implements DbDriver {
  readonly dialect = 'sqlite' as const;
  private db: any;
  /** 预处理语句缓存（避免每次查询重新 prepare） */
  private stmts = new Map<string, any>();

  constructor(file: string) {
    this.db = openSqlite(file);
    try {
      // WAL + NORMAL：写入不再每次全量 fsync
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      // 并发写事务排队等待而不是立刻报 SQLITE_BUSY（默认 0 会直接失败）
      this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    } catch { /* 老版本 SQLite 忽略 */ }
  }

  private stmt(sql: string): any {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      if (this.stmts.size >= STMT_CACHE_SIZE) this.stmts.clear();
      this.stmts.set(sql, s);
    }
    return s;
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.stmt(sql).all(...params) as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<ExecResult> {
    const info = this.stmt(sql).run(...params);
    return {
      insertId: Number(info.lastInsertRowid ?? 0),
      affectedRows: Number(info.changes ?? 0),
    };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    this.db.close?.();
  }
}

function openSqlite(file: string): any {
  try {
    const req = require as (id: string) => any;
    const { DatabaseSync } = req('node:sqlite');
    return new DatabaseSync(file);
  } catch {
    try {
      const req = require as (id: string) => any;
      const BetterSqlite3 = req('better-sqlite3');
      return new BetterSqlite3(file);
    } catch {
      throw new Error(
        '[ham-db] 没有可用的 SQLite 驱动：需要 Node.js >= 22.5（内置 node:sqlite），' +
          '或安装可选依赖 better-sqlite3。',
      );
    }
  }
}

/**
 * MySQL 驱动：mysql2 连接池，惰性加载。
 * 修复了 1.x 中"查询完成前就 release 连接"的问题（直接使用池查询，由池自行管理）。
 */
export class MysqlDriver implements DbDriver {
  readonly dialect = 'mysql' as const;
  private pool: any;

  constructor(options: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    charset: string;
    connectionLimit: number;
  }) {
    const req = require as (id: string) => any;
    const mysql = req('mysql2/promise');
    this.pool = mysql.createPool(options);
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.pool.query(sql, params);
    return rows as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<ExecResult> {
    const [result] = await this.pool.query(sql, params);
    const header = result as any;
    return {
      insertId: Number(header.insertId ?? 0),
      affectedRows: Number(header.affectedRows ?? 0),
    };
  }

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.pool.query(sql, params);
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }
}
