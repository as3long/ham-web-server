import 'reflect-metadata';
import { strict as assert } from 'assert';
import { test } from 'node:test';
import { Container } from '../container/Container';
import { Autowired, Injectable, Inject } from '../container/decorators';

@Injectable()
class ServiceA {}

@Injectable()
class ServiceB {
  constructor(public a: ServiceA) {}
}

@Injectable({ scope: 'transient' })
class TransientService {}

@Injectable({ scope: 'request' })
class RequestScopedService {}

@Injectable()
class WithValue {
  constructor(@Inject('APP_TOKEN') public token: any) {}
}

@Injectable()
class WithProps {
  @Autowired(ServiceA)
  public a!: ServiceA;
}

@Injectable()
class CircularA {
  constructor(@Inject('circB') public b: any) {}
}

@Injectable()
class CircularB {
  constructor(@Inject('circA') public a: any) {}
}

class MissingInjectable {}

test('IoC: 构造函数自动注入 + 单例缓存', () => {
  const c = new Container();
  c.registerClass(ServiceA);
  c.registerClass(ServiceB);
  const b1 = c.resolve(ServiceB);
  const b2 = c.resolve(ServiceB);
  assert.ok(b1.a instanceof ServiceA);
  assert.strictEqual(b1, b2); // 单例
  assert.strictEqual(b1.a, b2.a);
});

test('IoC: transient 作用域每次新建', () => {
  const c = new Container();
  c.registerClass(TransientService);
  assert.notStrictEqual(c.resolve(TransientService), c.resolve(TransientService));
});

test('IoC: @Inject 字符串令牌', () => {
  const c = new Container();
  c.registerValue('APP_TOKEN', { v: 42 });
  c.registerClass(WithValue);
  const w = c.resolve(WithValue);
  assert.deepStrictEqual(w.token, { v: 42 });
});

test('IoC: @Autowired 属性注入（含继承）', () => {
  const c = new Container();
  c.registerClass(ServiceA);
  c.registerClass(WithProps);
  const w = c.resolve(WithProps);
  assert.ok(w.a instanceof ServiceA);
});

test('IoC: 继承的 @Autowired 在注入计划缓存后仍生效', () => {
  @Injectable()
  class ChildWithProps extends WithProps {}

  const c = new Container();
  c.registerClass(ServiceA);
  c.registerClass(ChildWithProps);
  const w1 = c.resolve(ChildWithProps);
  const w2 = c.resolve(ChildWithProps);
  assert.ok(w1.a instanceof ServiceA);
  assert.ok(w2.a instanceof ServiceA);
});

test('IoC: 循环依赖检测', () => {
  const c = new Container();
  c.register('circA', { useClass: CircularA });
  c.register('circB', { useClass: CircularB });
  assert.throws(() => c.resolve('circA'), /循环依赖/);
});

test('IoC: 缺少 @Injectable 时报错', () => {
  const c = new Container();
  assert.throws(() => c.registerClass(MissingInjectable), /@Injectable/);
});

test('IoC: 基础类型参数给出友好提示', () => {
  @Injectable()
  class Bad {
    constructor(public n: number) {}
  }
  const c = new Container();
  c.registerClass(Bad);
  assert.throws(() => c.resolve(Bad), /@Inject/);
});

test('IoC: request 作用域', () => {
  const c = new Container();
  c.registerClass(RequestScopedService);
  c.registerClass(ServiceA);

  // 根容器不能解析 request 作用域
  assert.throws(() => c.resolve(RequestScopedService), /request 作用域/);

  // 不同请求容器得到不同实例
  const req1 = c.createRequestContainer();
  const req2 = c.createRequestContainer();
  const r1a = req1.resolve(RequestScopedService);
  const r1b = req1.resolve(RequestScopedService);
  assert.strictEqual(r1a, r1b); // 同一请求内缓存
  assert.notStrictEqual(r1a, req2.resolve(RequestScopedService)); // 跨请求隔离

  // 单例跨请求共享
  assert.strictEqual(req1.resolve(ServiceA), req2.resolve(ServiceA));
});

test('IoC: 未注册令牌报错', () => {
  const c = new Container();
  assert.throws(() => c.resolve('nope'), /未找到提供者/);
});
