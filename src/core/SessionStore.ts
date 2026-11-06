/**
 * 会话存储抽象。
 * 默认内存存储保持原有单进程行为；database 存储将会话写入数据库，多个 worker/PM2
 * 实例可共享同一 Cookie 下的登录态。
 */
import * as crypto from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { Session } from '../types';
import { ConfigService } from '../config/ConfigService';
import { Database } from '../database/Database';
import { ExecResult } from '../database/drivers';

export interface SessionStore {
  /** 存储类型：memory / database */
  readonly kind: 'memory' | 'database';
  /** 当前可见会话数（近似值，数据库存储下仅为本进程观测值；读取为同步） */
  readonly size: number;

  /** 异步初始化（数据库存储会建表；内存存储为 no-op） */
  init?(): Promise<void>;

  /** 同步取（仅内存存储可命中；数据库存储返回 undefined，由 get 异步读取） */
  peek(id: string): Session | undefined;

  /** 异步取（数据库存储用；内存存储降级为 peek） */
  get(id: string): Promise<Session | undefined>;

  /** 写入或更新会话 */
  set(session: Session): void | Promise<void | ExecResult>;

  /** 删除会话 */
  delete(id: string): void | Promise<void | ExecResult>;

  /** 清理过期会话 */
  sweep(now: number): void | Promise<void | ExecResult>;

  /** 关闭存储（清理本地状态，不清除数据库表） */
  close(): void | Promise<void | ExecResult>;
}

const SESSION_ID_BYTES = 24;

/** 生成 48 位 hex 会话 ID */
export function generateSessionId(): string {
  return crypto.randomBytes(SESSION_ID_BYTES).toString('hex');
}

/** 标识符校验，防止通过表前缀/表名注入 SQL */
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`[ham-session] 非法表名: ${JSON.stringify(name)}`);
  }
  return name;
}

/** 判断数据库会话行是否已过期或数据损坏 */
function isExpiredSession(row: any, now: number): boolean {
  if (!row || typeof row.expire !== 'number') return true;
  try {
    const data = row.data === undefined ? {} : typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    if (data === null || typeof data !== 'object') return true;
  } catch {
    return true;
  }
  return row.expire <= now;
}

/** SQLite 建表语句 */
const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS {{table}} (
  id TEXT PRIMARY KEY,
  expire INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS {{table}}_expire ON {{table}} (expire);
`;

/** MySQL 建表语句 */
const MYSQL_DDL = `
CREATE TABLE IF NOT EXISTS {{table}} (
  id VARCHAR(64) PRIMARY KEY,
  expire BIGINT NOT NULL,
  data LONGTEXT NOT NULL,
  KEY {{table}}_expire (expire)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

/** 内存会话存储：沿用原有 Map 语义，保留 sync peek/size 用于测试 */
export class MemorySessionStore implements SessionStore {
  readonly kind = 'memory';
  private store = new Map<string, Session>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private sessionMax: number,
    private cleanupInterval: number,
  ) {
    this.ensureCleanupTimer();
  }

  get size(): number {
    this.sweepExpired(Date.now());
    return this.store.size;
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  peek(id: string): Session | undefined {
    const session = this.store.get(id);
    if (!session) return undefined;
    if (session.expire <= Date.now()) {
      this.store.delete(id);
      return undefined;
    }
    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    return this.peek(id);
  }

  set(session: Session): void | Promise<void> {
    this.evictIfFull();
    this.store.set(session.id, session);
  }

  delete(id: string): void | Promise<void> {
    this.store.delete(id);
  }

  sweep(now: number): void | Promise<void> {
    for (const [key, session] of this.store) {
      if (session.expire <= now) this.store.delete(key);
    }
  }

  close(): void | Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.store.clear();
  }

  /** 容量满时淘汰插入最早的会话 */
  private evictIfFull(): void {
    if (this.sessionMax <= 0) return;
    if (this.store.size < this.sessionMax) return;
    const oldest = this.store.keys().next().value;
    if (oldest !== undefined) this.store.delete(oldest);
  }

  /** 首次创建会话时启动后台清理（unref，不阻止进程退出） */
  private ensureCleanupTimer(): void {
    if (this.cleanupTimer) return;
    const interval = this.cleanupInterval;
    if (!interval || interval <= 0) return;
    this.cleanupTimer = setInterval(() => this.sweepExpired(Date.now()), interval);
    this.cleanupTimer.unref();
  }

  private sweepExpired(now: number): void {
    this.sweep(now);
  }
}

/**
 * 数据库会话存储：多进程/PM2 共享会话。
 *
 * 表结构（由 init() 自动建表）：
 *   id TEXT/VARCHAR(64) PRIMARY KEY,
 *   expire INTEGER/BIGINT NOT NULL,
 *   data TEXT/LONGTEXT NOT NULL,
 *   KEY expire
 *
 * SQLite 用 WAL + busy_timeout（已由 SqliteDriver 设置），多 worker 写串行；MySQL 用连接池。
 */
export class DatabaseSessionStore implements SessionStore {
  readonly kind = 'database';
  private pendingWrites = new Set<Promise<void>>();
  private idSet = new Set<string>(); // 本进程见过的会话 ID，仅用于 size 观测

  constructor(
    private db: Database,
    private table: string,
  ) {}

  get size(): number {
    return this.idSet.size;
  }

  async init(): Promise<void> {
    const dialect = this.db.cfg.dbType;
    const ddl = dialect === 'sqlite' ? SQLITE_DDL : MYSQL_DDL;
    try {
      await this.db.exec(ddl.replace(/\{\{table\}\}/g, ident(this.table)));
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      // SQLite 并发建表可能碰上 locked/busy，稍后重试；MySQL IF NOT EXISTS 已幂等
      if (
        dialect === 'sqlite' &&
        /SQLITE_BUSY|SQLITE_LOCKED|locked|busy/i.test(message)
      ) {
        for (let i = 0; i < 3; i++) {
          await sleep(50 * (i + 1));
          try {
            await this.db.exec(ddl.replace(/\{\{table\}\}/g, ident(this.table)));
            return;
          } catch (retryErr) {
            if (i === 2) throw retryErr;
          }
        }
      }
      throw err;
    }
  }

  peek(id: string): Session | undefined {
    return undefined;
  }

  async get(id: string): Promise<Session | undefined> {
    const now = Date.now();
    const rows = await this.db.query<{ id: string; expire: number; data: string }>(
      `SELECT id, expire, data FROM ${ident(this.table)} WHERE id = ?`,
      [id],
    );
    const row = rows[0];
    if (!row) return undefined;

    if (isExpiredSession(row, now)) {
      await this.db.run(`DELETE FROM ${ident(this.table)} WHERE id = ?`, [id]);
      return undefined;
    }

    this.idSet.add(id);
    return {
      id: row.id,
      expire: row.expire,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : (row.data ?? {}),
    };
  }

  set(session: Session): void | Promise<void | ExecResult> {
    this.idSet.add(session.id);
    return this.db.run(
      `INSERT INTO ${ident(this.table)} (id, expire, data) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET expire = excluded.expire, data = excluded.data`,
      [session.id, session.expire, JSON.stringify(session.data ?? {})],
    );
  }

  delete(id: string): void | Promise<void | ExecResult> {
    this.idSet.delete(id);
    return this.db.run(`DELETE FROM ${ident(this.table)} WHERE id = ?`, [id]);
  }

  sweep(now: number): void | Promise<void | ExecResult> {
    return this.db.run(`DELETE FROM ${ident(this.table)} WHERE expire <= ?`, [now]);
  }

  close(): void | Promise<void | ExecResult> {
    this.idSet.clear();
    return Promise.allSettled(this.pendingWrites).then(() => undefined);
  }
}

/** 根据配置创建会话存储 */
export function createSessionStore(
  config: {
    sessionStore: 'memory' | 'database';
    sessionMax: number;
    sessionCleanupInterval: number;
  },
  db?: Database,
  dbPrefix = 'ham_',
): SessionStore {
  const kind = config.sessionStore;
  if (kind === 'database') {
    if (!db) {
      throw new Error(
        '[ham-session] sessionStore=database 需要 Database 实例，请确保注册了 Database',
      );
    }
    return new DatabaseSessionStore(db, `${dbPrefix}session`);
  }
  return new MemorySessionStore(config.sessionMax, config.sessionCleanupInterval);
}

/** 从数据库会话存储构建的 RestoreSession 上下文（供 SessionService 使用） */
export interface RestoredSession {
  session: Session | undefined;
  /** 响应结束后是否需要持久化 */
  needsPersist: boolean;
}

/** 判断会话在响应期间是否需要持久化（数据变化或过期时间大幅延后） */
export function needsSessionPersist(
  session: Session,
  snapshot: { data: string; expire: number },
  expires: number,
): boolean {
  const currentData = JSON.stringify(session.data ?? {});
  if (currentData !== snapshot.data) return true;
  if (session.expire - snapshot.expire > expires / 2) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
