import 'reflect-metadata';
import { strict as assert } from 'assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HamApplication } from '../application';
import { BaseController } from '../controller/BaseController';
import {
  Controller,
  Injectable,
  UseInterceptors,
} from '../container/decorators';
import { Context } from '../core/Context';
import { SessionService } from '../core/SessionService';
import { ConfigService } from '../config/ConfigService';
import { Interceptor, Next } from '../core/interceptor';

function fakeRes(headersSent = false, writableEnded = false) {
  const headers: Record<string, any> = {};
  return {
    headers,
    headersSent,
    writableEnded,
    statusCode: 200,
    getHeader: (k: string) => headers[k.toLowerCase()],
    setHeader: (k: string, v: any) => {
      headers[k.toLowerCase()] = v;
    },
  } as any;
}

test('SessionService: 新建会话写 Cookie，复用不重复写，ID 为 48 位十六进制', () => {
  const svc = new SessionService(
    new ConfigService({ sessionKey: 'sid', sessionExpires: 60_000 }),
  );

  const res1 = fakeRes();
  const s1 = svc.start({ headers: {} } as any, res1);
  assert.match(s1.id, /^[0-9a-f]{48}$/);
  assert.ok(String(res1.headers['set-cookie']).includes(`sid=${s1.id}`));

  // 携带 Cookie 的第二次请求复用同一会话，且不重复下发 Cookie
  const res2 = fakeRes();
  const s2 = svc.start({ headers: { cookie: `sid=${s1.id}` } } as any, res2);
  assert.strictEqual(s2, s1);
  assert.strictEqual(res2.headers['set-cookie'], undefined);

  svc.close();
});

test('SessionService: 响应已发送时跳过 Set-Cookie，不抛 ERR_HTTP_HEADERS_SENT', () => {
  const svc = new SessionService(new ConfigService({ sessionKey: 'sid' }));
  const res = fakeRes(true, true);
  const session = svc.start({ headers: {} } as any, res);
  assert.ok(session.id);
  assert.strictEqual(res.headers['set-cookie'], undefined);
  svc.close();
});

test('SessionService: 会话数量上限按插入顺序淘汰最旧', () => {
  const svc = new SessionService(
    new ConfigService({
      sessionKey: 'sid',
      sessionMax: 2,
      sessionCleanupInterval: 0,
    }),
  );
  const a = svc.start({ headers: {} } as any, fakeRes());
  svc.start({ headers: {} } as any, fakeRes());
  svc.start({ headers: {} } as any, fakeRes()); // 淘汰 a
  assert.strictEqual(svc.size, 2);

  // a 已被淘汰，携带其 Cookie 会得到新会话
  const resurrected = svc.start(
    { headers: { cookie: `sid=${a.id}` } } as any,
    fakeRes(),
  );
  assert.notStrictEqual(resurrected.id, a.id);
  svc.close();
});

@Controller('lazy')
class LazyController extends BaseController {
  constructor(ctx: Context) {
    super(ctx);
  }

  async noneAction() {
    return { ok: true };
  }

  async touchAction() {
    this.session.hits = (this.session.hits ?? 0) + 1;
    return { hits: this.session.hits, id: this.ctx.session.id };
  }
}

@Injectable()
class BeforeNextInterceptor implements Interceptor {
  async intercept(ctx: Context, next: Next): Promise<void> {
    ctx.session.data.touchedBefore = true;
    await next();
  }
}

@Injectable()
class AfterNextInterceptor implements Interceptor {
  async intercept(ctx: Context, next: Next): Promise<void> {
    await next();
    // 响应已结束后才首次访问 session：应跳过 Set-Cookie 而不是抛错
    ctx.session.data.touchedAfter = true;
  }
}

@Controller('before')
@UseInterceptors(BeforeNextInterceptor)
class BeforeController extends BaseController {
  constructor(ctx: Context) {
    super(ctx);
  }
  async indexAction() {
    return { ok: true };
  }
}

@Controller('after')
class AfterController extends BaseController {
  constructor(ctx: Context) {
    super(ctx);
  }
  @UseInterceptors(AfterNextInterceptor)
  async indexAction() {
    return { ok: true };
  }
}

test('HamApplication: 未访问 session 的请求不创建会话、不下发 Cookie', async () => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ham-session-'));
  fs.mkdirSync(path.join(appPath, 'views'));
  const app = new HamApplication({ appPath, config: { debug: false } });
  app.addController(LazyController);
  const server = await app.listen(0);
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/lazy/none`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('set-cookie'), null);
    assert.strictEqual(app.container.resolve(SessionService).size, 0);

    // 首次访问 session -> 创建会话并下发 Cookie
    const touched = await fetch(`${base}/lazy/touch`);
    const data: any = await touched.json();
    assert.strictEqual(data.hits, 1);
    const cookie = touched.headers.get('set-cookie') || '';
    assert.ok(cookie.includes('ham_session_id='));
    assert.strictEqual(app.container.resolve(SessionService).size, 1);

    // 复用会话 -> 不重复下发 Cookie
    const again = await fetch(`${base}/lazy/touch`, {
      headers: { cookie: cookie.split(';')[0] },
    });
    const againData: any = await again.json();
    assert.strictEqual(againData.hits, 2);
    assert.strictEqual(againData.id, data.id);
    assert.strictEqual(again.headers.get('set-cookie'), null);
  } finally {
    await app.close();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('HamApplication: 拦截器 next() 之前/之后首次访问 session 均安全', async () => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ham-session-aop-'));
  fs.mkdirSync(path.join(appPath, 'views'));
  const app = new HamApplication({ appPath, config: { debug: false } });
  app.addController(BeforeController);
  app.addController(AfterController);
  const server = await app.listen(0);
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const before = await fetch(`${base}/before`);
    assert.strictEqual(before.status, 200);
    assert.ok(
      (before.headers.get('set-cookie') || '').includes('ham_session_id='),
    );

    const after = await fetch(`${base}/after`);
    assert.strictEqual(after.status, 200);
    // 响应头已发送，跳过 Set-Cookie 且请求未失败
    assert.strictEqual(after.headers.get('set-cookie'), null);
    assert.deepStrictEqual(await after.json(), { ok: true });
  } finally {
    await app.close();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});
