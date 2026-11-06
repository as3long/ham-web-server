import * as crypto from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { Injectable, Inject } from '../container/decorators';
import { ConfigService } from '../config/ConfigService';
import { Database } from '../database/Database';
import { Logger, LoggerLike } from '../logging/Logger';
import { Session } from '../types';
import {
  appendSetCookie,
  parseCookie,
  serializeCookie,
} from '../utils';
import {
  SessionStore,
  MemorySessionStore,
  DatabaseSessionStore,
  createSessionStore,
  generateSessionId,
  needsSessionPersist,
} from './SessionStore';

const SESSION_COOKIE_PATH = '/';
const SESSION_COOKIE_SAME_SITE = 'Lax';

/**
 * 会话服务（单例）。
 *
 * - 默认内存存储（memory），与 1.x 行为一致；
 * - `sessionStore='database'` 时使用数据库会话存储，多进程/PM2 cluster 下共享会话；
 * - `start()` 保持同步，不改变现有测试语义；
 * - 新增 `init()`（建表/启动清理定时器）和 `restore(req, res)`（从 Cookie 恢复会话），
 *   在 `HamApplication.handle()` 中于 Context 创建前调用。
 */
@Injectable()
export class SessionService {
  private store: SessionStore;
  private cleanupTimer?: NodeJS.Timeout;
  private persistentWrites = new Set<Promise<void>>();

  constructor(
    private config: ConfigService,
    @Inject(Database) private db?: Database,
    @Inject(Logger) private logger?: LoggerLike,
  ) {
    const cfg = this.config.config;
    this.store = createSessionStore(
      {
        sessionStore: cfg.sessionStore,
        sessionMax: cfg.sessionMax,
        sessionCleanupInterval: cfg.sessionCleanupInterval,
      },
      this.db,
      cfg.dbPrefix,
    );
  }

  /** 异步初始化：数据库存储会建表，随后启动清理定时器 */
  async init(): Promise<void> {
    await this.store.init?.();
    this.ensureCleanupTimer();
  }

  /** 获取或创建会话（同步）：
   * - memory：直接命中/创建；
   * - database：命中内存缓存的会话直接复用，否则创建新会话并立即写数据库。
   * 仅在新建会话时写 Set-Cookie。
   */
  start(req: IncomingMessage, res: ServerResponse): Session {
    const cfg = this.config.config;
    const now = Date.now();
    const id = parseCookie(req.headers.cookie)[cfg.sessionKey];

    // 数据库存储没有同步 peek，若本进程已见过该 ID 则返回占位会话（将在 restore 时真正恢复）
    const existing = id ? this.store.peek(id) : undefined;
    if (existing && existing.expire > now) {
      existing.expire = now + cfg.sessionExpires;
      this.store.set(existing);
      return existing;
    }

    if (existing) this.store.delete(existing.id);

    const session: Session = {
      id: generateSessionId(),
      expire: now + cfg.sessionExpires,
      data: {},
    };
    this.store.set(session);
    this.ensureCleanupTimer();

    if (this.store.kind === 'database' && id) {
      // 现有 Cookie 的会话已存在，由 restore 负责从数据库读取；这里只是占位，
      // 不再重复写 Set-Cookie。
      return session;
    }

    // 响应已开始/结束时跳过 Set-Cookie，避免 ERR_HTTP_HEADERS_SENT
    if (!res.headersSent && !res.writableEnded) {
      appendSetCookie(
        res,
        serializeCookie(cfg.sessionKey, session.id, {
          path: SESSION_COOKIE_PATH,
          httpOnly: true,
          sameSite: SESSION_COOKIE_SAME_SITE,
        }),
      );
    }
    return session;
  }

  /**
   * 从 Cookie 恢复会话（异步，在 Context 创建前调用）。
   * - 无会话 Cookie：返回 undefined，由调用方使用 lazy session；
   * - 有 Cookie 但未命中：返回 undefined，新会话将在首次访问 ctx.session 时创建；
   * - 命中：刷新 expire，登记响应结束时的持久化，返回会话。
   */
  async restore(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<Session | undefined> {
    const cfg = this.config.config;
    const id = parseCookie(req.headers.cookie)[cfg.sessionKey];
    if (!id) return undefined;

    let session: Session | undefined;
    try {
      session = await this.store.get(id);
    } catch (err) {
      // 数据库会话读取失败不应打垮公开页面：记录并视为未登录
      this.logError('恢复会话失败', err, { sessionId: id });
      return undefined;
    }

    if (!session) return undefined;

    session.expire = Date.now() + cfg.sessionExpires;
    this.persistOnFinish(res, session);
    return session;
  }

  /** 立即销毁会话 */
  destroy(id: string): void {
    this.store.delete(id);
  }

  get size(): number {
    return this.store.size;
  }

  /** 停止清理定时器并等待待写入会话完成 */
  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    await Promise.allSettled(this.persistentWrites);
    await this.store.close?.();
  }

  /**
   * 响应结束后按需持久化会话（仅 database 存储生效）。
   * 比较响应开始时的数据快照与当前数据，只有真变化或过期时间需要续期时才写回，
   * 降低只读页面的写放大；写失败只记录日志，不影响响应。
   */
  private persistOnFinish(
    res: ServerResponse,
    session: Session,
  ): void {
    if (this.store.kind !== 'database') return;
    const snapshot = {
      data: JSON.stringify(session.data ?? {}),
      expire: session.expire,
    };
    const expires = this.config.config.sessionExpires;

    const persist = () => {
      try {
        if (!needsSessionPersist(session, snapshot, expires)) return;
        const write = Promise.resolve(this.store.set(session)).then(
          () => {
            this.persistentWrites.delete(write);
          },
          (err: unknown) => {
            this.persistentWrites.delete(write);
            this.logError('持久化会话失败', err, { sessionId: session.id });
          },
        );
        this.persistentWrites.add(write);
      } catch (err) {
        this.logError('序列化会话失败', err, { sessionId: session.id });
      }
    };

    res.once('finish', persist);
    res.once('close', persist);
  }

  /** 会话错误日志：有 Logger 时结构化输出，否则回退 console */
  private logError(
    message: string,
    err: unknown,
    meta: Record<string, unknown> = {},
  ): void {
    if (this.logger) {
      this.logger.error({ err, ...meta }, message);
      return;
    }
    console.error(`[ham-session] ${message}`, { ...meta, err });
  }

  /** 首次创建会话时启动后台清理（unref，不阻止进程退出） */
  private ensureCleanupTimer(): void {
    if (this.cleanupTimer) return;
    const interval = this.config.get('sessionCleanupInterval');
    if (!interval || interval <= 0) return;
    this.cleanupTimer = setInterval(() => this.sweepExpired(Date.now()), interval);
    this.cleanupTimer.unref();
  }

  private sweepExpired(now: number): void {
    this.store.sweep(now);
  }
}

/**
 * 惰性会话代理：首次读写任意属性（包括 `.data`）时才调用工厂创建会话。
 * 这样未访问 session 的请求（如 JSON API、404）不会产生 Cookie 与内存会话。
 */
export function createLazySession(factory: () => Session): Session {
  let real: Session | undefined;
  const resolveSession = (): Session => (real ??= factory());

  return new Proxy({} as Session, {
    get(_target, prop) {
      const session = resolveSession();
      return (session as any)[prop];
    },
    set(_target, prop, value) {
      const session = resolveSession();
      (session as any)[prop] = value;
      return true;
    },
    has(_target, prop) {
      return prop in resolveSession();
    },
    ownKeys() {
      return Reflect.ownKeys(resolveSession());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const desc = Object.getOwnPropertyDescriptor(resolveSession(), prop);
      // Proxy 不变量：目标对象可扩展时，返回的描述符必须可配置
      if (desc) desc.configurable = true;
      return desc;
    },
    deleteProperty(_target, prop) {
      return delete (resolveSession() as any)[prop];
    },
    defineProperty(_target, prop, desc) {
      return Reflect.defineProperty(resolveSession(), prop, desc);
    },
  });
}

