import { Injectable } from '../container/decorators';
import { ConfigService } from '../config/ConfigService';
import { LRUCache } from '../cache/LRUCache';
import { DbDriver, ExecResult, MysqlDriver, SqliteDriver } from './drivers';
import * as fs from 'fs';
import * as path from 'path';

export interface CompiledSql {
  sql: string;
  params: unknown[];
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** 查询缓存容量 */
const QUERY_CACHE_SIZE = 500;

/** 标识符（表名/列名）校验，防止通过 order/field 注入 */
function ident(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`[ham-orm] 非法标识符: ${JSON.stringify(name)}`);
  }
  return name;
}

function int(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`[ham-orm] ${what} 必须是非负整数，收到: ${value}`);
  }
  return value;
}

/**
 * 数据库服务（单例）：持有驱动连接与查询缓存。
 */
@Injectable()
export class Database {
  private driver?: DbDriver;
  private cache = new LRUCache(QUERY_CACHE_SIZE);

  constructor(
    private config: ConfigService,
    private appPath: string,
  ) {}

  get cfg() {
    return this.config.config;
  }

  /** 获取链式查询构建器（自动加表前缀） */
  table<T = Record<string, any>>(name: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this, this.cfg.dbPrefix + name);
  }

  /** SELECT 查询。cacheable=true 时走 LRU 缓存（TTL 取 sqlCacheTime） */
  async query<T = any>(
    sql: string,
    params: unknown[] = [],
    cacheable = false,
  ): Promise<T[]> {
    if (cacheable) {
      const key = cacheKey(sql, params);
      const hit = this.cache.get(key);
      if (hit !== undefined) return hit as T[];
      const rows = await this.ensureDriver().query<T>(sql, params);
      this.cache.set(key, rows, this.cfg.sqlCacheTime);
      return rows;
    }
    return this.ensureDriver().query<T>(sql, params);
  }

  /** INSERT/UPDATE/DELETE */
  async run(sql: string, params: unknown[] = []): Promise<ExecResult> {
    return this.ensureDriver().run(sql, params);
  }

  /** DDL 或其他语句 */
  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.ensureDriver().exec(sql, params);
  }

  async close(): Promise<void> {
    await this.driver?.close();
    this.driver = undefined;
  }

  private ensureDriver(): DbDriver {
    if (this.driver) return this.driver;
    const cfg = this.cfg;
    if (cfg.dbType === 'sqlite') {
      const file = path.resolve(this.appPath, cfg.sqlitePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.driver = new SqliteDriver(file);
      return this.driver;
    }
    if (cfg.dbType === 'mysql') {
      this.driver = new MysqlDriver({
        host: cfg.dbHost,
        port: cfg.dbPort,
        database: cfg.dbName,
        user: cfg.dbUser,
        password: cfg.dbPwd,
        charset: cfg.dbCharset,
        connectionLimit: cfg.dbConnLimit,
      });
      return this.driver;
    }
    throw new Error(`[ham-db] 不支持的数据库类型: ${cfg.dbType}`);
  }
}

function cacheKey(sql: string, params: unknown[]): string {
  return sql + '\u0000' + JSON.stringify(params);
}

/**
 * 链式查询构建器（对应 1.x 的 Model 链式 API）：
 *
 *   db.table<User>('user').where({ id: 1 }).find()
 *   db.table('user').where('id', '>', 5).order('id', 'DESC').page(1, 10).select()
 *
 * 值全部走参数化查询；标识符（表名/列名）做格式校验。
 */
export class QueryBuilder<T = Record<string, any>> {
  private whereParts: string[] = [];
  private whereParams: unknown[] = [];
  private fields: string[] = [];
  private orderParts: string[] = [];
  private joinParts: string[] = [];
  private limitN?: number;
  private offsetN?: number;
  private cacheable = false;

  constructor(
    private db: Database,
    private table: string,
  ) {}

  // ------------------------------------------------------------- 链式条件

  /** 对象条件（等值 / null 转 IS NULL）或字符串键值 */
  where(cond: Partial<T> | string, value?: unknown): this;
  /** 运算符条件：where('age', '>', 18) */
  where(key: string, operator: string, value: unknown): this;
  where(cond: Partial<T> | string, valueOrOp?: unknown, maybeValue?: unknown): this {
    if (typeof cond === 'string') {
      if (maybeValue !== undefined || isOperator(valueOrOp)) {
        const op = String(valueOrOp);
        if (!/^(!=|<>|>=|<=|=|>|<|like|LIKE)$/.test(op)) {
          throw new Error(`[ham-orm] 不支持的运算符: ${op}`);
        }
        this.whereParts.push(`${ident(cond)} ${op === '<>' ? '!=' : op} ?`);
        this.whereParams.push(maybeValue ?? (valueOrOp as any));
      } else {
        this.whereParts.push(`${ident(cond)} = ?`);
        this.whereParams.push(valueOrOp);
      }
      return this;
    }
    for (const [key, value] of Object.entries(cond)) {
      if (value === null || value === undefined) {
        this.whereParts.push(`${ident(key)} IS NULL`);
      } else {
        this.whereParts.push(`${ident(key)} = ?`);
        this.whereParams.push(value);
      }
    }
    return this;
  }

  whereRaw(sql: string, params: unknown[] = []): this {
    this.whereParts.push(sql);
    this.whereParams.push(...params);
    return this;
  }

  whereNull(key: string): this {
    this.whereParts.push(`${ident(key)} IS NULL`);
    return this;
  }

  /** 查询列；可变参数或数组 */
  field(col: string, ...more: string[]): this;
  field(cols: string[]): this;
  field(col: string | string[], ...more: string[]): this {
    this.fields.push(...(Array.isArray(col) ? col : [col, ...more]));
    return this;
  }

  /** order('id', 'DESC') 或 order('id DESC') */
  order(col: string, dir: 'ASC' | 'DESC' = 'ASC'): this {
    if (/\s+(asc|desc)$/i.test(col.trim())) {
      const [c, d] = col.trim().split(/\s+/);
      this.orderParts.push(`${ident(c)} ${d.toUpperCase()}`);
    } else {
      const direction = String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      this.orderParts.push(`${ident(col)} ${direction}`);
    }
    return this;
  }

  limit(n: number, offset?: number): this {
    this.limitN = int(n, 'limit');
    if (offset !== undefined) this.offsetN = int(offset, 'offset');
    return this;
  }

  /** 分页：page(1, 10) 取第 1 页每页 10 条 */
  page(pageNo: number, size = 6): this {
    const p = Math.max(1, int(pageNo, 'page'));
    const s = int(size, 'size');
    this.limitN = s;
    this.offsetN = (p - 1) * s;
    return this;
  }

  /** INNER JOIN：join('profile', 'userId', 'id') -> ON profile.userId = user.id（自动加表前缀） */
  join(table2: string, t2Key: string, t1Key: string): this {
    const t2 = this.db.cfg.dbPrefix + table2;
    this.joinParts.push(
      `INNER JOIN ${ident(t2)} ON ${ident(`${t2}.${t2Key}`)} = ${ident(`${this.table}.${t1Key}`)}`,
    );
    return this;
  }

  /** 启用查询缓存（TTL 取配置 sqlCacheTime） */
  cache(): this {
    this.cacheable = true;
    return this;
  }

  // ------------------------------------------------------------- SQL 生成

  /** 生成 SELECT 语句（供测试与调试） */
  compileSelect(forceLimit?: number): CompiledSql {
    const cols = this.fields.length ? this.fields.map(ident).join(', ') : '*';
    let sql = `SELECT ${cols} FROM ${ident(this.table)}`;
    for (const join of this.joinParts) sql += ` ${join}`;
    const where = this.whereParts.join(' AND ');
    if (where) sql += ` WHERE ${where}`;
    if (this.orderParts.length) sql += ` ORDER BY ${this.orderParts.join(', ')}`;

    let limit: number | undefined = this.limitN;
    let offset: number | undefined = this.offsetN;
    if (forceLimit !== undefined && this.limitN === undefined) limit = forceLimit;
    if (limit !== undefined) {
      sql += ` LIMIT ${int(limit, 'limit')}`;
      if (offset !== undefined) sql += ` OFFSET ${int(offset, 'offset')}`;
    }
    return { sql, params: [...this.whereParams] };
  }

  /** 生成 INSERT 语句 */
  compileInsert(data: Partial<T>): CompiledSql {
    const keys = Object.keys(data);
    if (!keys.length) throw new Error('[ham-orm] add() 数据为空');
    keys.forEach(ident);
    const sql = `INSERT INTO ${ident(this.table)} (${keys.join(', ')}) VALUES (${keys
      .map(() => '?')
      .join(', ')})`;
    return { sql, params: keys.map((k) => (data as any)[k]) };
  }

  /** 生成 UPDATE 语句（必须有 where 条件，防止全表更新） */
  compileUpdate(data: Partial<T>): CompiledSql {
    const keys = Object.keys(data);
    if (!keys.length) throw new Error('[ham-orm] update() 数据为空');
    if (!this.whereParts.length) {
      throw new Error('[ham-orm] update() 缺少 where 条件（拒绝全表更新）');
    }
    keys.forEach(ident);
    const sql = `UPDATE ${ident(this.table)} SET ${keys
      .map((k) => `${k} = ?`)
      .join(', ')} WHERE ${this.whereParts.join(' AND ')}`;
    return { sql, params: [...keys.map((k) => (data as any)[k]), ...this.whereParams] };
  }

  /** 生成 DELETE 语句（必须有 where 条件，防止全表删除） */
  compileDelete(): CompiledSql {
    if (!this.whereParts.length) {
      throw new Error('[ham-orm] delete() 缺少 where 条件（拒绝全表删除）');
    }
    const sql = `DELETE FROM ${ident(this.table)} WHERE ${this.whereParts.join(' AND ')}`;
    return { sql, params: [...this.whereParams] };
  }

  compileCount(col = '*'): CompiledSql {
    const expr = col === '*' ? 'COUNT(*)' : `COUNT(${ident(col)})`;
    let sql = `SELECT ${expr} AS c FROM ${ident(this.table)}`;
    for (const join of this.joinParts) sql += ` ${join}`;
    const where = this.whereParts.join(' AND ');
    if (where) sql += ` WHERE ${where}`;
    return { sql, params: [...this.whereParams] };
  }

  // ------------------------------------------------------------- 执行

  /** 查询列表 */
  async select(): Promise<T[]> {
    const { sql, params } = this.compileSelect();
    return this.db.query<T>(sql, params, this.cacheable);
  }

  /** 查询单条（自动 LIMIT 1），无结果返回 null */
  async find(): Promise<T | null> {
    const { sql, params } = this.compileSelect(1);
    const rows = await this.db.query<T>(sql, params, this.cacheable);
    return rows[0] ?? null;
  }

  /** 取标量值（如 COUNT/MAX 结果） */
  async value(col = '*'): Promise<any> {
    const { sql, params } = this.compileCount(col);
    const rows = await this.db.query<any>(sql, params, this.cacheable);
    return rows.length ? Number(Object.values(rows[0])[0]) : 0;
  }

  /** 统计行数 */
  async count(col = '*'): Promise<number> {
    return this.value(col);
  }

  /** 插入，返回 insertId */
  async add(data: Partial<T>): Promise<ExecResult> {
    const { sql, params } = this.compileInsert(data);
    return this.db.run(sql, params);
  }

  /** 更新，返回受影响行数 */
  async update(data: Partial<T>): Promise<ExecResult> {
    const { sql, params } = this.compileUpdate(data);
    return this.db.run(sql, params);
  }

  /** 删除，返回受影响行数 */
  async delete(): Promise<ExecResult> {
    const { sql, params } = this.compileDelete();
    return this.db.run(sql, params);
  }
}

function isOperator(v: unknown): boolean {
  return typeof v === 'string' && /^(!=|<>|>=|<=|=|>|<|like)$/i.test(v);
}
