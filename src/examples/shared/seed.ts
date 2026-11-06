/**
 * 多进程安全的种子数据填充。
 *
 * 多个 worker 并发启动时，`seedIfEmpty` 的“先查 count 再插入”会导致重复种子。
 * 使用 `ham_seed` 表的唯一主键 + 事务，保证同一表只被一个 worker 成功填充，
 * 其他 worker 因唯一键冲突而回滚并视为“已有数据”。
 */
import { Database } from '../../database/Database';

export async function safeSeed(
  db: Database,
  key: string,
  seedFn: () => Promise<void>,
): Promise<boolean> {
  const dialect = db.cfg.dbType;
  const table = `${db.cfg.dbPrefix ?? 'ham_'}seed`;
  await ensureSeedTable(db, table);

  // 先检查标记：已标记则直接跳过（快路径，无需事务）
  const marked = await db.table<{ k: string }>('seed').where({ k: key }).find();
  if (marked) return false;

  if (dialect === 'sqlite') {
    return seedInTransaction(db, table, key, seedFn, 'BEGIN IMMEDIATE');
  }
  return seedInTransaction(db, table, key, seedFn, 'START TRANSACTION');
}

/** 确保 ham_seed 表存在 */
async function ensureSeedTable(db: Database, table: string): Promise<void> {
  if (db.cfg.dbType === 'sqlite') {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL DEFAULT '',
        createdAt INTEGER NOT NULL DEFAULT 0
      );
    `);
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        k VARCHAR(128) PRIMARY KEY,
        v TEXT NOT NULL DEFAULT '',
        createdAt BIGINT NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  }
}

/** 在事务内执行种子填充；冲突时视为其他 worker 已处理 */
async function seedInTransaction(
  db: Database,
  table: string,
  key: string,
  seedFn: () => Promise<void>,
  beginSql: string,
): Promise<boolean> {
  await db.exec(beginSql);
  try {
    // 事务内再次检查（另一 worker 可能刚提交）
    const marked = await db.table<{ k: string }>('seed').where({ k: key }).find();
    if (marked) {
      await db.exec('ROLLBACK');
      return false;
    }
    await seedFn();
    await db.run(`INSERT INTO ${table} (k, v, createdAt) VALUES (?, ?, ?)`, [
      key,
      '',
      Date.now(),
    ]);
    await db.exec('COMMIT');
    return true;
  } catch (err) {
    try {
      await db.exec('ROLLBACK');
    } catch {
      /* 忽略回滚失败 */
    }
    const message = (err as Error)?.message ?? String(err);
    const isDuplicate =
      /SQLITE_CONSTRAINT|UNIQUE|ER_DUP_ENTRY|Duplicate entry/i.test(message);
    if (isDuplicate) {
      // 另一 worker 已插入相同 key，视为已处理
      return false;
    }
    throw err;
  }
}
