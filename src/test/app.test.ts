import 'reflect-metadata';
import { strict as assert } from 'assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HamApplication } from '../application';
import { BaseController } from '../controller/BaseController';
import { Controller, Injectable } from '../container/decorators';
import { Context } from '../core/Context';

@Injectable()
class Counter {
  n = 0;
  inc(): number {
    return ++this.n;
  }
}

@Controller('index')
class IndexController extends BaseController {
  constructor(
    ctx: Context,
    private counter: Counter,
  ) {
    super(ctx);
  }

  async indexAction() {
    this.session.visits = (this.session.visits ?? 0) + 1;
    this.assign({ name: 'world', visits: this.session.visits, counter: this.counter.inc() });
    this.display('index');
  }

  async apiAction() {
    return { ok: true, counter: this.counter.inc(), visits: this.session.visits ?? 0 };
  }

  async echoAction() {
    const name = this.post('name') ?? '';
    return { name };
  }

  async redirectAction() {
    this.redirect('/index/api');
  }
}

async function fetchText(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  return { res, body: await res.text() };
}

test('HamApplication: 端到端（路由/视图/Session/IoC/静态/安全）', async () => {
  // 准备应用目录
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ham-app-'));
  fs.mkdirSync(path.join(appPath, 'views'));
  fs.mkdirSync(path.join(appPath, 'static'));
  fs.writeFileSync(
    path.join(appPath, 'views', 'index.html'),
    '<h1>hello {{name}}</h1><span data-v="{{visits}}" data-c="{{counter}}"></span>',
  );
  fs.writeFileSync(path.join(appPath, 'static', 'a.css'), 'body { color: red; }');
  fs.writeFileSync(path.join(appPath, 'secret.html'), '<p>TOPSECRET</p>');

  const app = new HamApplication({
    appPath,
    config: { debug: true, enableXss: true },
  });
  app.register(Counter);
  app.addController(IndexController);
  const server = await app.listen(0); // 随机端口，避免与本机其他服务冲突
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. 模板渲染 + 构造函数注入 + 会话
    const first = await fetchText(`${base}/`);
    assert.strictEqual(first.res.status, 200);
    assert.ok(first.body.includes('hello world'));
    let cookie = first.res.headers.get('set-cookie') || '';
    assert.ok(cookie.includes('ham_session_id='));
    assert.ok(cookie.toLowerCase().includes('httponly'));
    const v1 = Number(first.body.match(/data-v="(\d+)"/)?.[1]);
    assert.strictEqual(v1, 1);

    // 2. 会话延续：带 Cookie 再次访问，访问计数 +1
    const second = await fetchText(`${base}/`, {
      headers: { cookie: cookie.split(';')[0] },
    });
    const v2 = Number(second.body.match(/data-v="(\d+)"/)?.[1]);
    assert.strictEqual(v2, 2);

    // 3. 单例服务跨请求共享（第二次请求也让 Counter +1，故 api 应为 c2 + 1）
    const c2 = Number(second.body.match(/data-c="(\d+)"/)?.[1]);
    const api = await fetchText(`${base}/index/api`);
    const apiData = JSON.parse(api.body);
    assert.strictEqual(apiData.ok, true);
    assert.strictEqual(apiData.counter, c2 + 1); // Counter 单例延续

    // 4. 静态资源
    const css = await fetchText(`${base}/static/a.css`);
    assert.strictEqual(css.res.status, 200);
    assert.ok(css.res.headers.get('content-type')?.includes('text/css'));
    assert.strictEqual(css.body, 'body { color: red; }');

    // 5. 路径穿越防护：appPath 下的 secret.html 不能通过 static 逃逸读到
    const evil1 = await fetchText(`${base}/%2e%2e/secret.html`);
    assert.ok(!evil1.body.includes('TOPSECRET'), '路径穿越被拦截');
    const evil2 = await fetchText(`${base}/..%2fsecret.html`);
    assert.ok(!evil2.body.includes('TOPSECRET'), '编码穿越被拦截');

    // 6. 404
    const missing = await fetchText(`${base}/nosuch/thing`);
    assert.strictEqual(missing.res.status, 404);

    // 7. POST + XSS 过滤 + JSON 响应
    const posted = await fetchText(`${base}/index/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=<script>alert(1)</script>Tom',
    });
    const postedData = JSON.parse(posted.body);
    assert.ok(!postedData.name.includes('<script>'), 'XSS 已过滤');
    assert.ok(postedData.name.includes('Tom'));

    // 8. JSON 请求体
    const jsonPosted = await fetchText(`${base}/index/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '李四' }),
    });
    assert.deepStrictEqual(JSON.parse(jsonPosted.body), { name: '李四' });

    // 9. 重定向
    const redirectRes = await fetch(`${base}/index/redirect`, { redirect: 'manual' });
    assert.strictEqual(redirectRes.status, 302);
    assert.strictEqual(redirectRes.headers.get('location'), '/index/api');
  } finally {
    await app.close();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('StaticServer: 异步处理支持 ETag/Last-Modified/304/HEAD', async () => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ham-static-http-'));
  fs.mkdirSync(path.join(appPath, 'views'));
  fs.mkdirSync(path.join(appPath, 'static'));
  const css = 'body { color: red; }';
  fs.writeFileSync(path.join(appPath, 'static', 'a.css'), css);

  const app = new HamApplication({ appPath, config: { debug: false } });
  const server = await app.listen(0);
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const first = await fetch(`${base}/static/a.css`);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(await first.text(), css);
    assert.ok(first.headers.get('content-type')?.includes('text/css'));
    assert.strictEqual(first.headers.get('content-length'), String(Buffer.byteLength(css)));
    assert.ok(first.headers.get('cache-control')?.includes('max-age=120'));
    const etag = first.headers.get('etag');
    const lastModified = first.headers.get('last-modified');
    assert.ok(etag);
    assert.ok(lastModified);

    const byEtag = await fetch(`${base}/static/a.css`, {
      headers: { 'if-none-match': etag as string },
    });
    assert.strictEqual(byEtag.status, 304);
    assert.strictEqual(await byEtag.text(), '');

    const byTime = await fetch(`${base}/static/a.css`, {
      headers: { 'if-modified-since': lastModified as string },
    });
    assert.strictEqual(byTime.status, 304);

    const head = await fetch(`${base}/static/a.css`, { method: 'HEAD' });
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.headers.get('content-length'), String(Buffer.byteLength(css)));
    assert.strictEqual(await head.text(), '');

    // 不存在的静态文件回落到 MVC 404
    const missing = await fetch(`${base}/static/missing.css`);
    assert.strictEqual(missing.status, 404);
  } finally {
    await app.close();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('HamApplication: 运行期新增守卫会使路由计划失效并生效', async () => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ham-plan-'));
  fs.mkdirSync(path.join(appPath, 'views'));

  @Controller('plan')
  class PlanController extends BaseController {
    constructor(ctx: Context) {
      super(ctx);
    }
    async indexAction() {
      return { ok: true };
    }
  }

  const app = new HamApplication({ appPath, config: { debug: false } });
  app.addController(PlanController);
  const server = await app.listen(0);
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const before = await fetch(`${base}/plan`);
    assert.strictEqual(before.status, 200);

    app.addGuard(async () => false); // 运行期注册 -> 计划版本递增
    const after = await fetch(`${base}/plan`);
    assert.strictEqual(after.status, 403);
  } finally {
    await app.close();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('HamApplication: 动作抛错返回 500（非调试模式隐藏细节）', async () => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ham-err-'));
  fs.mkdirSync(path.join(appPath, 'views'));

  @Controller('boom')
  class BoomController extends BaseController {
    constructor(ctx: Context) {
      super(ctx);
    }
    async indexAction(): Promise<void> {
      throw new Error('SECRET-STACK-MARKER');
    }
  }

  const app = new HamApplication({ appPath, config: { debug: false } });
  app.addController(BoomController);
  const server = await app.listen(0);
  const port = (server.address() as any).port;

  try {
    const { res, body } = await fetchText(`http://127.0.0.1:${port}/boom`);
    assert.strictEqual(res.status, 500);
    assert.ok(!body.includes('SECRET-STACK-MARKER'));
    assert.ok(body.includes('服务器出现错误'));
  } finally {
    await app.close();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});
