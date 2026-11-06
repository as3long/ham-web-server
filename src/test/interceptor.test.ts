import 'reflect-metadata';
import { strict as assert } from 'assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compose } from '../core/interceptor';
import { Interceptor, Next } from '../core/interceptor';
import { UseInterceptors, Injectable, Controller, Inject } from '../container/decorators';
import { BaseController } from '../controller/BaseController';
import { Context } from '../core/Context';
import { ConfigService } from '../config/ConfigService';
import { HamApplication } from '../application';

// =========================================================== compose 单元测试

test('compose: 洋葱模型执行顺序', async () => {
  const calls: string[] = [];
  const a: Interceptor = {
    async intercept(_ctx, next) {
      calls.push('a-before');
      await next();
      calls.push('a-after');
    },
  };
  const b: Interceptor = {
    async intercept(_ctx, next) {
      calls.push('b-before');
      await next();
      calls.push('b-after');
    },
  };
  await compose([a, b], async () => { calls.push('final'); })({} as any);
  assert.deepStrictEqual(calls, ['a-before', 'b-before', 'final', 'b-after', 'a-after']);
});

test('compose: 短路（不调用 next）则后续不执行', async () => {
  const calls: string[] = [];
  const a: Interceptor = {
    async intercept(_ctx, _next) { calls.push('a'); }, // 短路
  };
  await compose([a], async () => { calls.push('final'); })({} as any);
  assert.deepStrictEqual(calls, ['a']);
});

test('compose: 内层错误可被外层捕获并恢复', async () => {
  const calls: string[] = [];
  const a: Interceptor = {
    async intercept(_ctx, next) {
      try {
        await next();
        calls.push('no-error');
      } catch {
        calls.push('caught');
      }
    },
  };
  await compose([a], async () => { throw new Error('boom'); })({} as any);
  assert.deepStrictEqual(calls, ['caught']);
});

test('compose: 未捕获错误向上传播', async () => {
  const boom: Interceptor = { async intercept() { throw new Error('inner-boom'); } };
  await assert.rejects(
    () => compose([boom], async () => { calls(); })({} as any),
    /inner-boom/,
  );
  function calls() { /* unreachable */ }
});

test('compose: 同一拦截器重复调用 next() 被拒绝', async () => {
  const bad: Interceptor = {
    async intercept(_ctx, next) { await next(); await next(); },
  };
  await assert.rejects(
    () => compose([bad], async () => {})({} as any),
    /多次/,
  );
});

// =========================================================== 集成测试

@Injectable()
class Trace {
  readonly log: string[] = [];
  note(...items: string[]): void { this.log.push(...items); }
}

/** 全局拦截器（类，注入 Trace） */
@Injectable()
class GlobalTraceInterceptor {
  constructor(private trace: Trace) {}
  async intercept(_ctx: Context, next: Next): Promise<void> {
    this.trace.note('g-before');
    await next();
    this.trace.note('g-after');
  }
}

/** 控制器级拦截器（类） */
@Injectable()
class ControllerTraceInterceptor {
  constructor(private trace: Trace) {}
  async intercept(_ctx: Context, next: Next): Promise<void> {
    this.trace.note('c-before');
    await next();
    this.trace.note('c-after');
  }
}

/** 动作级拦截器（类） */
@Injectable()
class ActionTraceInterceptor {
  constructor(private trace: Trace) {}
  async intercept(_ctx: Context, next: Next): Promise<void> {
    this.trace.note('a-before');
    await next();
    this.trace.note('a-after');
  }
}

/** 鉴权拦截器：演示短路 */
@Injectable()
class AuthInterceptor {
  async intercept(ctx: Context, next: Next): Promise<void> {
    if (ctx.get('token') !== 'secret') {
      ctx.status(401);
      ctx.echo({ ok: false, error: 'unauthorized' }, 401);
      return; // 短路：动作不会执行
    }
    return next();
  }
}

function makeApp() {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ham-aop-'));
  fs.mkdirSync(path.join(appPath, 'views'));

  @Controller('index')
  @UseInterceptors(ControllerTraceInterceptor) // 控制器级：本控制器全部动作
  class IndexController extends BaseController {
    constructor(ctx: Context, private trace: Trace) { super(ctx); }

    @UseInterceptors(ActionTraceInterceptor) // 动作级：仅本动作
    async indexAction() {
      this.trace.note('action');
      return { ok: true };
    }

    async otherAction() {
      this.trace.note('other-action');
      return { ok: true, other: true };
    }
  }

  @Controller('admin')
  class AdminController extends BaseController {
    constructor(ctx: Context) { super(ctx); }
    @UseInterceptors(AuthInterceptor)
    async secretAction() {
      return { ok: true, secret: 'S3CR3T' };
    }
  }

  const app = new HamApplication({ appPath, config: { debug: false } });
  app.register(Trace);
  app.addInterceptor(GlobalTraceInterceptor); // 全局
  app.addInterceptor(async (ctx, next) => {   // 函数式全局拦截器
    ctx.setHeader('X-Fn-Interceptor', '1');
    await next();
  });
  app.addController(IndexController);
  app.addController(AdminController);
  return { app, appPath };
}

test('HamApplication: 全局/控制器/动作三级拦截器按洋葱顺序执行', async () => {
  const { app, appPath } = makeApp();
  const server = await app.listen(0);
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/index`);
    const body: any = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(res.headers.get('x-fn-interceptor'), '1'); // 函数式拦截器生效

    const trace = app.container.resolve(Trace);
    assert.deepStrictEqual(trace.log, [
      'g-before', 'c-before', 'a-before', 'action', 'a-after', 'c-after', 'g-after',
    ]);
  } finally {
    await app.close();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('HamApplication: 控制器级拦截器作用于全部动作，动作级仅作用于目标动作', async () => {
  const { app, appPath } = makeApp();
  const server = await app.listen(0);
  const port = (server.address() as any).port;
  try {
    await fetch(`http://127.0.0.1:${port}/index/other`);
    const trace = app.container.resolve(Trace);
    assert.deepStrictEqual(trace.log, [
      'g-before', 'c-before', 'other-action', 'c-after', 'g-after', // 没有 a-before/a-after
    ]);
  } finally {
    await app.close();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('HamApplication: 拦截器短路后动作不执行', async () => {
  const { app, appPath } = makeApp();
  const server = await app.listen(0);
  const port = (server.address() as any).port;
  try {
    // 无 token -> 401，动作未执行
    const denied = await fetch(`http://127.0.0.1:${port}/admin/secret`);
    assert.strictEqual(denied.status, 401);
    assert.deepStrictEqual(await denied.json(), { ok: false, error: 'unauthorized' });

    // 带 token -> 200，动作执行
    const ok = await fetch(`http://127.0.0.1:${port}/admin/secret?token=secret`);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(((await ok.json()) as any).secret, 'S3CR3T');
  } finally {
    await app.close();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('HamApplication: 拦截器中的依赖注入（@Inject 字符串令牌）', async () => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ham-aop-di-'));
  fs.mkdirSync(path.join(appPath, 'views'));

  @Injectable()
  class VersionHeaderInterceptor {
    constructor(@Inject('APP_VERSION') private version: string) {}
    async intercept(ctx: Context, next: Next): Promise<void> {
      ctx.setHeader('X-App-Version', this.version);
      await next();
    }
  }

  @Controller('index')
  class IndexController extends BaseController {
    constructor(ctx: Context) { super(ctx); }
    async indexAction() { return { ok: true }; }
  }

  const app = new HamApplication({ appPath, config: { debug: false } });
  app.registerValue('APP_VERSION', '9.9.9-test');
  app.addInterceptor(VersionHeaderInterceptor);
  app.addController(IndexController);
  const server = await app.listen(0);
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/index`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-app-version'), '9.9.9-test');
  } finally {
    await app.close();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});

test('HamApplication: 拦截器捕获动作错误后可自行响应（不再 500）', async () => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ham-aop-err-'));
  fs.mkdirSync(path.join(appPath, 'views'));

  @Injectable()
  class RecoverInterceptor {
    async intercept(ctx: Context, next: Next): Promise<void> {
      try {
        await next();
      } catch {
        ctx.echo({ ok: false, fallback: true }, 200);
      }
    }
  }

  @Controller('index')
  class IndexController extends BaseController {
    constructor(ctx: Context) { super(ctx); }
    @UseInterceptors(RecoverInterceptor)
    async indexAction(): Promise<void> { throw new Error('boom'); }
  }

  const app = new HamApplication({ appPath, config: { debug: false } });
  app.addInterceptor(RecoverInterceptor);
  app.addController(IndexController);
  const server = await app.listen(0);
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/index`);
    assert.strictEqual(res.status, 200); // 拦截器兜底，不是 500
    assert.deepStrictEqual(await res.json(), { ok: false, fallback: true });
  } finally {
    await app.close();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
});
