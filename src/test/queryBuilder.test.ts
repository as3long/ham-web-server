import 'reflect-metadata';
import { strict as assert } from 'assert';
import { test } from 'node:test';
import { ConfigService } from '../config/ConfigService';
import { Database, QueryBuilder } from '../database/Database';
import { SqliteDriver } from '../database/drivers';

// ------------------------------------------------------------- SQL 生成

const db = new Database(new ConfigService({ dbPrefix: 'ham_' }), '/tmp/app');

test('QueryBuilder: where 对象 + find 自动 LIMIT 1', () => {
  const q = db.table('user').where({ id: 1, status: 2 });
  const { sql, params } = q.compileSelect(1);
  assert.strictEqual(sql, 'SELECT * FROM ham_user WHERE id = ? AND status = ? LIMIT 1');
  assert.deepStrictEqual(params, [1, 2]);
});

test('QueryBuilder: field/order/limit/page/join', () => {
  const { sql } = db
    .table('user')
    .field('id', 'name')
    .join('profile', 'userId', 'id')
    .where('age', '>', 18)
    .order('id', 'DESC')
    .page(2, 6)
    .compileSelect();
  assert.strictEqual(
    sql,
    'SELECT id, name FROM ham_user INNER JOIN ham_profile ON ham_profile.userId = ham_user.id ' +
      'WHERE age > ? ORDER BY id DESC LIMIT 6 OFFSET 6',
  );
});

test('QueryBuilder: order 字符串形式', () => {
  const { sql } = db.table('user').order('createdAt desc').compileSelect();
  assert.ok(sql.endsWith('ORDER BY createdAt DESC'));
});

test('QueryBuilder: null 条件转 IS NULL', () => {
  const { sql, params } = db.table('user').where({ name: null }).compileSelect();
  assert.strictEqual(sql, 'SELECT * FROM ham_user WHERE name IS NULL');
  assert.deepStrictEqual(params, []);
});

test('QueryBuilder: add/update/delete', () => {
  const ins = db.table('user').compileInsert({ name: 'a', email: 'b@x' } as any);
  assert.strictEqual(ins.sql, 'INSERT INTO ham_user (name, email) VALUES (?, ?)');
  assert.deepStrictEqual(ins.params, ['a', 'b@x']);

  const upd = db.table('user').where({ id: 1 }).compileUpdate({ name: 'b' } as any);
  assert.strictEqual(upd.sql, 'UPDATE ham_user SET name = ? WHERE id = ?');
  assert.deepStrictEqual(upd.params, ['b', 1]);

  const del = db.table('user').where({ id: 1 }).compileDelete();
  assert.strictEqual(del.sql, 'DELETE FROM ham_user WHERE id = ?');
});

test('QueryBuilder: 标识符与危险参数校验', () => {
  assert.throws(() => db.table('user; DROP TABLE x').compileSelect(), /非法标识符/);
  assert.throws(() => db.table('user').order('id; DROP').compileSelect(), /非法标识符/);
  assert.throws(() => db.table('user').where('1=1', 1).compileSelect(), /非法标识符/);
  assert.throws(() => db.table('user').where('age', '><', 1).compileSelect(), /运算符/);
  assert.throws(() => db.table('user').compileUpdate({ n: 1 } as any), /缺少 where/);
  assert.throws(() => db.table('user').compileDelete(), /缺少 where/);
  assert.throws(() => db.table('user').limit(-1).compileSelect(), /limit/);
});

// ------------------------------------------------------------- SQLite 集成

const sqliteAvailable = (() => {
  try {
    // eslint-disable-next-line no-new
    new SqliteDriver(':memory:');
    return true;
  } catch {
    return false;
  }
})();

interface UserRow {
  id: number;
  name: string;
  createdAt: number;
}

test('SQLite: 完整 CRUD 往返', { skip: sqliteAvailable ? false : '无 SQLite 驱动' }, async () => {
  const memory = new Database(new ConfigService({ sqlitePath: ':memory:' }), '/tmp/app');
  // 让 sqlitePath 直接生效：':memory:' 不是有效相对路径处理目标，直接建驱动
  (memory as any).driver = new SqliteDriver(':memory:');

  await memory.exec(`CREATE TABLE ham_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  )`);

  const r1 = await memory.table<UserRow>('users').add({ name: '张三', createdAt: 100 } as any);
  assert.ok(r1.insertId >= 1);
  await memory.table<UserRow>('users').add({ name: '李四', createdAt: 200 } as any);

  const all = await memory.table<UserRow>('users').order('id', 'ASC').select();
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].name, '张三');

  const one = await memory.table<UserRow>('users').where('id', r1.insertId).find();
  assert.strictEqual(one?.name, '张三');

  const page2 = await memory.table<UserRow>('users').page(2, 1).order('id', 'ASC').select();
  assert.strictEqual(page2.length, 1);
  assert.strictEqual(page2[0].name, '李四');

  const count = await memory.table<UserRow>('users').count();
  assert.strictEqual(count, 2);

  await memory.table<UserRow>('users').where({ id: r1.insertId }).update({ name: '王五' } as any);
  const renamed = await memory.table<UserRow>('users').where('id', r1.insertId).find();
  assert.strictEqual(renamed?.name, '王五');

  const del = await memory.table<UserRow>('users').where({ id: r1.insertId }).delete();
  assert.strictEqual(del.affectedRows, 1);
  assert.strictEqual(await memory.table<UserRow>('users').count(), 1);

  // 参数化：值中的 SQL 片段不会被当语句执行
  await memory.table<UserRow>('users').add({ name: "x'); DROP TABLE ham_users;--", createdAt: 1 } as any);
  const rows = await memory.table<UserRow>('users').count();
  assert.strictEqual(rows, 2);
  await memory.close();
});
