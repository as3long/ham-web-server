import 'reflect-metadata';
import { Scope, Token, Type } from '../types';
import {
  META_INJECTABLE,
  META_PARAM_INJECT,
  META_PROP_INJECT,
  META_SCOPE,
} from './decorators';

interface ProviderRecord {
  token: Token<any>;
  scope: Scope;
  useClass?: Type<any>;
  useValue?: any;
  useFactory?: (c: Container) => any;
}

export interface RegisterOptions {
  /** 是否要求类必须标注 @Injectable()（默认要求，控制器除外） */
  requireInjectable?: boolean;
}

function tokenName(token: Token<any> | undefined): string {
  if (token === undefined) return 'undefined';
  if (typeof token === 'function') return token.name || '(anonymous class)';
  if (typeof token === 'symbol') return token.toString();
  return String(token);
}

const WRAPPER_TYPES = new Set([Object, String, Number, Boolean, Array]);

interface InjectionPlan {
  /** 每个构造参数最终使用的令牌（@Inject 优先于 design:paramtypes） */
  params: Token<any>[];
  /** 属性注入令牌（已沿原型链合并，子类覆盖父类） */
  props: Array<{ key: string | symbol; token: Token<any> }>;
}

/** 类 -> 注入元数据缓存（反射读取与原型链遍历只做一次） */
const injectionPlans = new WeakMap<Type<any>, InjectionPlan>();

function getInjectionPlan(ctor: Type<any>): InjectionPlan {
  let plan = injectionPlans.get(ctor);
  if (!plan) {
    const paramTypes: Token<any>[] =
      Reflect.getMetadata('design:paramtypes', ctor) ?? [];
    const injects: Record<number, Token<any>> =
      Reflect.getMetadata(META_PARAM_INJECT, ctor) ?? {};
    plan = {
      params: paramTypes.map((type, i) => injects[i] ?? type),
      props: collectAutowiredProps(ctor),
    };
    injectionPlans.set(ctor, plan);
  }
  return plan;
}

/**
 * 轻量级 IoC 容器。
 *
 * - 支持三种作用域：singleton（默认）、transient、request
 * - 基于 reflect-metadata 的构造函数自动注入，配合 @Inject / @Autowired
 * - createRequestContainer() 创建请求级子容器，用于解析 request 作用域依赖
 * - 检测循环依赖并给出清晰报错
 */
export class Container {
  private records = new Map<Token<any>, ProviderRecord>();
  private instances = new Map<Token<any>, any>();
  private readonly isRequestContainer: boolean;

  constructor(private readonly parent: Container | null = null) {
    this.isRequestContainer = parent !== null;
  }

  // ---------------------------------------------------------------- 注册

  /** 注册一个类（令牌即类本身）。默认读取 @Injectable 中声明的作用域。 */
  registerClass<T>(
    type: Type<T>,
    scope?: Scope,
    options?: RegisterOptions,
  ): this {
    const decorated =
      scope ?? (Reflect.getMetadata(META_SCOPE, type) as Scope) ?? 'singleton';
    return this.register(type, { useClass: type }, decorated, options);
  }

  /** 注册一个常量值 */
  registerValue<T>(token: Token<T>, value: T): this {
    return this.register(token, { useValue: value }, 'singleton');
  }

  /** 注册一个工厂函数 */
  registerFactory<T>(
    token: Token<T>,
    factory: (c: Container) => T,
    scope: Scope = 'singleton',
  ): this {
    return this.register(token, { useFactory: factory }, scope);
  }

  register<T>(
    token: Token<T>,
    provider: {
      useClass?: Type<any>;
      useValue?: any;
      useFactory?: (c: Container) => any;
    },
    scope: Scope = 'singleton',
    options?: RegisterOptions,
  ): this {
    if (provider.useClass) {
      const injectable = Reflect.getMetadata(META_INJECTABLE, provider.useClass);
      if (!injectable && options?.requireInjectable !== false) {
        throw new Error(
          `[ham-ioc] ${tokenName(provider.useClass)} 缺少 @Injectable() 装饰器，无法注册到容器。`,
        );
      }
    }
    this.records.set(token, { token, scope, ...provider });
    return this;
  }

  /** 某令牌是否可解析（含父容器） */
  has(token: Token<any>): boolean {
    let c: Container | null = this;
    while (c) {
      if (c.records.has(token) || c.instances.has(token)) return true;
      c = c.parent;
    }
    return false;
  }

  // ---------------------------------------------------------------- 解析

  /** 解析依赖。request 作用域的提供者只能从请求容器解析。 */
  resolve<T>(token: Token<T>): T {
    return this.resolveInternal(token, this, []);
  }

  /**
   * 创建请求级子容器。
   * request 作用域的实例缓存在子容器中，请求结束后随子容器一起丢弃；
   * 单例仍然缓存到根容器，跨请求共享。
   */
  createRequestContainer(): Container {
    return new Container(this);
  }

  private resolveInternal(
    token: Token<any>,
    requester: Container,
    stack: Token<any>[],
  ): any {
    // 自下而上寻找拥有该令牌（实例或记录）的容器
    let owner: Container | null = this;
    while (owner) {
      if (owner.instances.has(token)) return owner.instances.get(token);
      if (owner.records.has(token)) break;
      owner = owner.parent;
    }
    if (!owner) {
      const hint =
        tokenName(token) === 'Context'
          ? '（Context 只能在请求处理期间从请求容器解析）'
          : '。请先 registerValue/registerFactory/registerClass 或添加 @Injectable()。';
      throw new Error(`[ham-ioc] 未找到提供者: ${tokenName(token)}${hint}`);
    }

    const rec = owner.records.get(token)!;

    if (rec.scope === 'request' && !requester.isRequestContainer) {
      throw new Error(
        `[ham-ioc] ${tokenName(token)} 是 request 作用域，不能注入到单例服务中；` +
          `请把使用方声明为 @Injectable({ scope: 'request' })，或在控制器/动作中按请求解析。`,
      );
    }

    if (stack.includes(token)) {
      const chain = [...stack, token].map(tokenName).join(' -> ');
      throw new Error(`[ham-ioc] 检测到循环依赖: ${chain}`);
    }
    // 复用同一个栈做 push/pop，避免每一层依赖都复制一次数组
    stack.push(token);
    try {
      let instance: any;
      if (rec.useValue !== undefined || 'useValue' in rec) {
        instance = rec.useValue;
      } else if (rec.useFactory) {
        instance = rec.useFactory(requester);
      } else if (rec.useClass) {
        instance = this.instantiateClass(rec.useClass, requester, stack);
      } else {
        throw new Error(`[ham-ioc] ${tokenName(token)} 的提供者配置为空`);
      }

      // 单例缓存到拥有该记录的容器；request 作用域缓存到请求容器
      if (rec.scope === 'singleton') {
        owner.instances.set(token, instance);
      } else if (rec.scope === 'request') {
        requester.instances.set(token, instance);
      }
      return instance;
    } finally {
      stack.pop();
    }
  }

  private instantiateClass(
    ctor: Type<any>,
    requester: Container,
    stack: Token<any>[],
  ): any {
    const plan = getInjectionPlan(ctor);

    const args = plan.params.map((token, i) => {
      if (token === undefined || WRAPPER_TYPES.has(token as any)) {
        throw new Error(
          `[ham-ioc] ${ctor.name} 构造函数第 ${i} 个参数类型无法自动注入（${tokenName(token)}）。` +
            `请为参数指定具体类类型，或使用 @Inject(token) 显式指定令牌。`,
        );
      }
      return requester.resolveInternal(token, requester, stack);
    });

    const instance = new ctor(...args);

    // 属性注入（元数据已缓存，含原型链合并）
    for (const { key, token } of plan.props) {
      (instance as any)[key] = requester.resolveInternal(
        token,
        requester,
        stack,
      );
    }
    return instance;
  }
}

function collectAutowiredProps(
  ctor: Type<any>,
): Array<{ key: string | symbol; token: Token<any> }> {
  const merged = new Map<string | symbol, Token<any>>();
  let proto: any = ctor.prototype;
  while (proto && proto !== Object.prototype) {
    const list: Array<{ key: string | symbol; token: Token<any> }> | undefined =
      Reflect.getMetadata(META_PROP_INJECT, proto);
    if (list) for (const item of list) if (!merged.has(item.key)) merged.set(item.key, item.token);
    proto = Object.getPrototypeOf(proto);
  }
  return [...merged.entries()].map(([key, token]) => ({ key, token }));
}
