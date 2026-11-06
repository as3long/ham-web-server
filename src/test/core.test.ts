import 'reflect-metadata';
import { strict as assert } from 'assert';
import { test } from 'node:test';
import { StaticServer } from '../core/StaticServer';
import { SessionService } from '../core/SessionService';
import { ConfigService } from '../config/ConfigService';
import { parseRoute } from '../core/Router';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test('Router: 伪静态 URL 解析', () => {
  assert.deepStrictEqual(parseRoute('/'), { controller: 'index', action: 'index', args: [] });
  assert.deepStrictEqual(parseRoute('/user'), { controller: 'user', action: 'index', args: [] });
  assert.deepStrictEqual(parseRoute('/user/list.html'), { controller: 'user', action: 'list', args: [] });
  assert.deepStrictEqual(parseRoute('/user/api/5.html'), { controller: 'user', action: 'api', args: ['5'] });
  assert.deepStrictEqual(parseRoute('/a/b/c/d'), { controller: 'a', action: 'b', args: ['c', 'd'] });
  assert.deepStrictEqual(parseRoute('/x/y/%E4%B8%AD'), { controller: 'x', action: 'y', args: ['中'] });
});

test('StaticServer: 正常解析与路径穿越防护', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ham-static-'));
  const appRoot = fs.mkdtempSync(path.join(tmp, 'app-'));
  const staticRoot = path.join(appRoot, 'static');
  fs.mkdirSync(staticRoot);
  fs.writeFileSync(path.join(staticRoot, 'a.css'), 'body{}');
  fs.writeFileSync(path.join(appRoot, 'secret.html'), '<p>机密</p>');

  const server = new StaticServer(appRoot, 'static');

  // 正常文件
  assert.strictEqual(server.resolve('/a.css'), path.join(staticRoot, 'a.css'));
  assert.strictEqual(server.resolve('/sub/../a.css'), path.join(staticRoot, 'a.css'));

  // 路径穿越：%2e%2e 解码后逃出 static 目录 -> 拒绝
  assert.strictEqual(server.resolve('/%2e%2e/secret.html'), null);
  assert.strictEqual(server.resolve('/..%2fsecret.html'), null);

  // 非白名单扩展名
  assert.strictEqual(server.resolve('/a.exe'), null);
  assert.strictEqual(server.resolve('/secret.htmlx'), null);

  // 目录本身不存在
  assert.strictEqual(server.resolve('/missing.css'), null);

  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeRes() {
  const headers: Record<string, any> = {};
  return {
    headers,
    statusCode: 200,
    getHeader: (k: string) => headers[k.toLowerCase()],
    setHeader: (k: string, v: any) => { headers[k.toLowerCase()] = v; },
  } as any;
}

test('SessionService: 创建/复用/过期', () => {
  const svc = new SessionService(new ConfigService({ sessionKey: 'sid', sessionExpires: 1000 }));

  const res1 = fakeRes();
  const s1 = svc.start({ headers: {} } as any, res1);
  assert.ok(s1.id);
  const cookie = res1.headers['set-cookie'];
  assert.ok(String(cookie).includes('sid='));
  assert.ok(String(cookie).includes('HttpOnly')); // 1.x 没有的安全修复
  assert.ok(String(cookie).includes('SameSite=Lax'));

  // 携带 Cookie 的第二次请求复用同一会话
  const res2 = fakeRes();
  const s2 = svc.start({ headers: { cookie: `sid=${s1.id}` } } as any, res2);
  assert.strictEqual(s2.id, s1.id);

  // 过期后新建会话
  s1.expire = Date.now() - 1;
  const res3 = fakeRes();
  const s3 = svc.start({ headers: { cookie: `sid=${s1.id}` } } as any, res3);
  assert.notStrictEqual(s3.id, s1.id);
  assert.strictEqual(svc.size, 1); // 过期会话已被清理
});
