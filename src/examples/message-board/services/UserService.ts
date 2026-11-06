import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { Injectable } from '../../../container/decorators';
import { Database } from '../../../database/Database';
import {
  ADMIN_FLAG,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SALT_BYTES,
  SCRYPT_KEY_LENGTH,
  TABLE,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '../constants';

export interface UserRow {
  id: number;
  username: string;
  passwordHash: string;
  salt: string;
  /** 管理员标志：1 = 管理员（首个注册的用户自动成为管理员） */
  isAdmin: number;
  createdAt: number;
}

/** 用户名规则：中文 / 字母 / 数字 / 下划线，长度由常量控制 */
export const USERNAME_RE = new RegExp(
  `^[\\u4e00-\\u9fa5\\w]{${USERNAME_MIN_LENGTH},${USERNAME_MAX_LENGTH}}$`,
);

/**
 * 用户服务：注册 / 登录验证 / 修改密码。
 *
 * 密码使用 Node 内置 scrypt + 随机盐存储（不存明文，防彩虹表），
 * 比对使用 timingSafeEqual 防时序攻击。
 */
@Injectable()
export class UserService {
  constructor(private db: Database) {}

  /** 建表（幂等，应用启动时调用） */
  async ensureTable(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS ham_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        passwordHash TEXT NOT NULL,
        salt TEXT NOT NULL,
        isAdmin INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  async findByUsername(username: string): Promise<UserRow | null> {
    return this.db.table<UserRow>(TABLE.USERS).where({ username }).find();
  }

  async findById(id: number): Promise<UserRow | null> {
    return this.db.table<UserRow>(TABLE.USERS).where({ id }).find();
  }

  /**
   * 注册新用户。返回 null 表示成功，否则返回可直接展示给用户的错误消息。
   */
  async register(username: string, password: string): Promise<string | null> {
    if (!USERNAME_RE.test(username)) {
      return `用户名需为 ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} 位中文、字母、数字或下划线`;
    }
    const err = passwordRuleError(password);
    if (err) return err;

    const salt = randomBytes(SALT_BYTES).toString('hex');
    const passwordHash = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('hex');

    await this.db.exec('BEGIN IMMEDIATE');
    try {
      // 事务内再次检查：另一 worker 可能刚注册了同名用户
      if (await this.findByUsername(username)) {
        await this.db.exec('ROLLBACK');
        return '用户名已被占用';
      }

      // 权限约定：用户表为空时，第一个注册的用户自动成为管理员
      const isFirstUser = (await this.db.table<UserRow>(TABLE.USERS).count()) === 0;

      await this.db.table<UserRow>(TABLE.USERS).add({
        username,
        passwordHash,
        salt,
        isAdmin: isFirstUser ? ADMIN_FLAG.YES : ADMIN_FLAG.NO,
        createdAt: Date.now(),
      } as Partial<UserRow>);
      await this.db.exec('COMMIT');
      return null;
    } catch (err) {
      try {
        await this.db.exec('ROLLBACK');
      } catch {
        /* 忽略回滚失败 */
      }
      const message = (err as Error)?.message ?? String(err);
      if (/UNIQUE|SQLITE_CONSTRAINT/i.test(message)) return '用户名已被占用';
      throw err;
    }
  }

  /** 登录验证：成功返回用户，失败返回 null */
  async verify(username: string, password: string): Promise<UserRow | null> {
    const user = await this.findByUsername(username);
    if (!user) return null;
    const actual = Buffer.from(
      scryptSync(password, user.salt, SCRYPT_KEY_LENGTH).toString('hex'),
      'hex',
    );
    const expected = Buffer.from(user.passwordHash, 'hex');
    const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
    return ok ? user : null;
  }

  /**
   * 修改密码。返回 null 表示成功，否则返回错误消息。
   */
  async changePassword(
    userId: number,
    oldPassword: string,
    newPassword: string,
  ): Promise<string | null> {
    const user = await this.findById(userId);
    if (!user) return '用户不存在';
    if (oldPassword === newPassword) return '新密码不能与旧密码相同';
    if (!(await this.verify(user.username, oldPassword))) return '旧密码不正确';
    const err = passwordRuleError(newPassword);
    if (err) return err.replace('密码', '新密码');

    const salt = randomBytes(SALT_BYTES).toString('hex');
    await this.db.table<UserRow>(TABLE.USERS).where({ id: user.id }).update({
      passwordHash: scryptSync(
        newPassword,
        salt,
        SCRYPT_KEY_LENGTH,
      ).toString('hex'),
      salt,
    } as Partial<UserRow>);
    return null;
  }
}

function passwordRuleError(password: string): string | null {
  if (
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    return `密码长度需为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位`;
  }
  return null;
}
