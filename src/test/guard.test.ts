import 'reflect-metadata';
import { strict as assert } from 'assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canAllActivate, toGuard } from '../core/guard';
import { Guard, GuardLike } from '../core/guard';
import { UseGuards, UseInterceptors, Injectable, Controller, Inject } from '../container/decorators';
import { Container } from '../container/Container';
import { BaseController } from '../controller/BaseController';
import { Context } from '../core/Context';
import { Interceptor, Next } from '../core/interceptor';
import { HamApplication } from '../application';

// =========================================================== 单元测试

test('canAllActivate: 顺序执行，全部通过才放行（支持同步/异步守卫）', async () => {
  const calls: string[] = [];
  const g1: Guard = { async canActivate() { calls.push('g1'); return true; } };
  const g2: Guard = { canActivate() { calls.push('g2'); return true; } }; // 同步守卫
  assert.strictEqual(await canAllActivate([g1, g2], {} as any), true);
  assert.deepStrictEqual(calls, ['g1', 'g2']);
});

test('canAllActivate: 任一拒绝即短路，后续守卫不再执行', async () => {
  const calls: string[] = [];
  const pass: Guard = { canActivate() { calls.push('pass'); return true; } };
  const deny: Guard = { async canActivate() { calls.push('deny'); return false; } };
  const never: Guard = { canActivate() { calls.push('never'); return true; } };
  assert.strictEqual(await canAllActivate([pass, deny, never], {} as any), false);
  assert.deepStrictEqual(calls, ['pass', 'deny']);
});

test('toGuard: 类经容器解析（DI）/ 实例直用 / 函数包装 / 非法形态抛错', async () => {
  const container = new Container();

  @Injectable()
  class DiGuard implements Guard {
    constructor(@Inject('GUARD_FLAG') private flag: string) {}
    canActivate(): boolean { return this.flag === 'yes'; }
  }
  container.registerValue('GUARD_FLAG', 'yes');
  container.registerClass(DiGuard);
  assert.strictEqual(await toGuard(DiGuard, container).canActivate({} as any), true);

  const instance: Guard = { canActivate: () => false };
  assert.strictEqual(await toGuard(instance, container).canActivate({} as any), false);

  const fn: GuardLike = (ctx) => (ctx as any).ok === true;
  assert.strictEqual(await toGuard(fn, container).canActivate({ ok: true } as any), true);

  assert.throws(() => toGuard({} as any, container), /无效的守卫/);
});

// =========================================================== 集成测试

@Injectable()
class Trace {
  readonly log: string[] = [];
  note(...items: string[]): void { this.log.push(...items); }
}

/** 全局守卫（类，注入 Trace，异步） */
@Injectable()
class GlobalPassGuard {
  constructor(private trace: Trace) {}
  async canActivate(_ctx: Context): Promise<boolean> {
    this.trace.note('g-guard');
    return true;
  }
}

/** 控制器级守卫（同步返回） */
@Injectable()
class ControllerPassGuard {
  constructor(private trace: Trace) {}
  canActivate(): boolean {
    this.trace.note('c-guard');
    return true;
  }
}

/** 动作级守卫 */
@Injectable()
class ActionPassGuard {
  constructor(private trace: Trace) {}
  async canActivate(): Promise<boolean> {
    this.trace.note('a-guard');
    return true;
  }
}

/** 拒绝守卫：返回 false 且不自行响应 -> 框架默认 403 */
@Injectable()
class DenyGuard {
  async canActivate(): Promise<boolean> { return false; }
}

/** 自响应守卫：拒绝前自行输出 401 -> 默认 403 不覆盖 */
@Injectable()
class SelfRespondGuard {
  canActivate(ctx: Context): boolean {
    ctx.status(401);
    ctx.echo({ ok: false, error: 'unauthorized' }, 401);
    return false;
  }
}

/** 动作级拦截器：用于验证“守卫先于拦截器” */
@Injectable()
class ActionTraceInterceptor implements Interceptor {
  constructor(private trace: Trace) {}
  async intercept(_ctx: Context, next: Next): Promise<void> {
    this.trace.note('i-before');
    await next();
    this.trace.note('i-after');
  }
}

function makeApp() {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ham-guard-'));
  fs.mkdirSync(path.join(appPath, 'views'));

  @Controller('index')
  @UseGuards(ControllerPassGuard) // 控制器级：本控制器全部动作
  class IndexController extends BaseController {
    constructor(ctx: Context, private trace: Trace) { super(ctx); }

    @UseGuards(ActionPassGuard) // 动作级守卫
    @UseInterceptors(ActionTraceInterceptor)
    async indexAction() {
      this.trace.note('action');
      return { ok: true };
    }

    @UseGuards(DenyGuard) // 拒绝 + 默认 403
    @UseInterceptors(ActionTraceInterceptor)
    async deniedAction() {
      this.trace.note('denied-action');
      return { ok: true };
    }

    @UseGuards(SelfRespondGuard) // 拒绝 + 自行响应 401
    async selfDeniedAction() {
      this.trace.note('self-denied-action');
      return { ok: true };
    }
  }

  const app = new HamApplication({ appPath, config: { debug: false } });
  app.register(Trace);
  app.addGuard(GlobalPassGuard); // 全局（类）
  app.addGuard(async (ctx) => ctx.url.pathname !== '/blocked'); // 全局（函数式）
  // 注意：守卫类都未手工注册 -> 同时验证 @UseGuards/addGuard 的自动注册
  app.addController(IndexController);
  return { app, appPath };
}

async function withApp<T>(
  app: HamApplication,
  appPath: string,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const server = await app.listen(0);
  const port = (server.address() as any).port;
  try {
    return await fn(port);
  } finally {
    await app.close();
    fs.rmSync(appPath, { recursive: true, force: true });
  }
}

test('HamApplication: 全局/控制器/动作三级守卫按序执行，通过后进入拦截器洋葱', async () => {
  const { app, appPath } = makeApp();
  await withApp(app, appPath, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/index`);
    const body: any = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.ok, true);

    const trace = app.container.resolve(Trace);
    // 守卫（全局->控制器->动作）先全部通过，然后才是拦截器洋葱
    assert.deepStrictEqual(trace.log, [
      'g-guard', 'c-guard', 'a-guard', 'i-before', 'action', 'i-after',
    ]);
  });
});

test('HamApplication: 函数式全局守卫可拒绝请求（默认 403）', async () => {
  const { app, appPath } = makeApp();
  await withApp(app, appPath, async (port) => {
    const denied = await fetch(`http://127.0.0.1:${port}/blocked`);
    assert.strictEqual(denied.status, 403);
    assert.ok((await denied.text()).includes('无权访问'));
  });
});

test('HamApplication: 守卫拒绝时默认 403，动作与拦截器都不执行', async () => {
  const { app, appPath } = makeApp();
  await withApp(app, appPath, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/index/denied`);
    assert.strictEqual(res.status, 403);
    assert.ok((await res.text()).includes('无权访问'));

    const trace = app.container.resolve(Trace);
    assert.deepStrictEqual(trace.log, ['g-guard', 'c-guard']); // i-before/action 均未出现
  });
});

test('HamApplication: 守卫自行响应（401 JSON）优先于默认 403', async () => {
  const { app, appPath } = makeApp();
  await withApp(app, appPath, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/index/selfDenied`);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(await res.json(), { ok: false, error: 'unauthorized' });

    const trace = app.container.resolve(Trace);
    assert.ok(!trace.log.includes('self-denied-action')); // 动作未执行
  });
});

test('HamApplication: 守卫中的依赖注入（@Inject 字符串令牌）', async () => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ham-guard-di-'));
  fs.mkdirSync(path.join(appPath, 'views'));

  @Injectable()
  class VersionGuard {
    constructor(@Inject('APP_VERSION') private version: string) {}
    canActivate(ctx: Context): boolean {
      ctx.setHeader('X-App-Version', this.version);
      return true;
    }
  }

  @Controller('index')
  class IndexController extends BaseController {
    constructor(ctx: Context) { super(ctx); }
    async indexAction() { return { ok: true }; }
  }

  const app = new HamApplication({ appPath, config: { debug: false } });
  app.registerValue('APP_VERSION', '9.9.9-guard');
  app.addGuard(VersionGuard);
  app.addController(IndexController);
  await withApp(app, appPath, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/index`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-app-version'), '9.9.9-guard');
  });
});
