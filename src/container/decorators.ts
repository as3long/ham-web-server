import 'reflect-metadata';
import type { InterceptorLike } from '../core/interceptor';
import type { GuardLike } from '../core/guard';
import { Scope, Token } from '../types';

/** 元数据键 */
export const META_INJECTABLE = 'ham:injectable';
export const META_SCOPE = 'ham:scope';
export const META_PARAM_INJECT = 'ham:inject:param';
export const META_PROP_INJECT = 'ham:inject:prop';
export const META_CONTROLLER = 'ham:controller';
export const META_INTERCEPTORS_CLASS = 'ham:interceptors:class';
export const META_INTERCEPTORS_METHOD = 'ham:interceptors:method';
export const META_GUARDS_CLASS = 'ham:guards:class';
export const META_GUARDS_METHOD = 'ham:guards:method';

/**
 * 标记一个类为可注入服务。
 * 默认单例；`@Injectable({ scope: 'transient' })` 每次解析创建新实例；
 * `@Injectable({ scope: 'request' })` 每个请求一个实例（只能从请求容器解析）。
 */
export function Injectable(options?: { scope?: Scope }): ClassDecorator {
  return (target: any) => {
    Reflect.defineMetadata(META_INJECTABLE, true, target);
    Reflect.defineMetadata(META_SCOPE, options?.scope ?? 'singleton', target);
  };
}

/**
 * 构造函数参数注入：用于类型不是类令牌（接口、字符串、Symbol、配置对象）时显式指定令牌。
 *
 * @example
 * constructor(@Inject('APP_CONFIG') private cfg: AppConfig) {}
 */
export function Inject(token: Token<any>): ParameterDecorator {
  return (target: any, _propertyKey, parameterIndex: number) => {
    const meta: Record<number, Token<any>> =
      Reflect.getMetadata(META_PARAM_INJECT, target) ?? {};
    meta[parameterIndex] = token;
    Reflect.defineMetadata(META_PARAM_INJECT, meta, target);
  };
}

/**
 * 属性注入：字段无需在构造函数中显式传入。
 *
 * @example
 * class OrderService {
 *   @Autowired(Database) private db!: Database;
 * }
 */
export function Autowired(token: Token<any>): PropertyDecorator {
  return (target: any, propertyKey: string | symbol) => {
    const meta: Array<{ key: string | symbol; token: Token<any> }> =
      Reflect.getMetadata(META_PROP_INJECT, target) ?? [];
    meta.push({ key: propertyKey, token });
    Reflect.defineMetadata(META_PROP_INJECT, meta, target);
  };
}

/**
 * 控制器装饰器：注册路由名（URL 第一段）。
 * 缺省时取类名去掉 Controller 后缀并小写，如 UserController -> user。
 *
 * @example
 * @Controller('user')
 * export class UserController extends BaseController { ... }
 */
export function Controller(name?: string): ClassDecorator {
  return (target: any) => {
    const controllerName =
      name ?? target.name.replace(/Controller$/, '').toLowerCase();
    Reflect.defineMetadata(META_CONTROLLER, { name: controllerName }, target);
  };
}

/**
 * 声明拦截器（AOP）：
 * - 用在控制器类上：拦截该控制器的所有动作
 * - 用在动作方法上：仅拦截该动作（比类级更靠近动作执行）
 *
 * 拦截器类经 IoC 容器解析，可在其构造函数中注入任意服务。
 * 执行顺序（洋葱模型）：全局 -> 基类 -> 子类 -> 基类动作级 -> 子类动作级 -> 动作。
 *
 * @example
 * @Controller('admin')
 * @UseInterceptors(AuthInterceptor)               // 控制器级
 * export class AdminController extends BaseController {
 *   @UseInterceptors(AuditInterceptor)            // 动作级
 *   async deleteAction() { ... }
 * }
 */
export function UseInterceptors(
  ...interceptors: InterceptorLike[]
): ClassDecorator & MethodDecorator {
  return declareOnChain(META_INTERCEPTORS_CLASS, META_INTERCEPTORS_METHOD, interceptors);
}

/**
 * 声明守卫（鉴权）：
 * - 用在控制器类上：守卫该控制器的所有动作
 * - 用在动作方法上：仅守卫该动作
 *
 * 守卫按 全局 -> 控制器级 -> 动作级 顺序执行，任一返回 false 即拒绝；
 * 守卫先于拦截器与请求体解析执行，拒绝时动作与拦截器都不会运行。
 * 守卫类经 IoC 容器解析，可在其构造函数中注入任意服务。
 *
 * @example
 * @Controller('admin')
 * @UseGuards(AdminRoleGuard)                     // 控制器级
 * export class AdminController extends BaseController {
 *   @UseGuards(OwnerOnlyGuard)                   // 动作级
 *   async deleteAction() { ... }
 * }
 */
export function UseGuards(...guards: GuardLike[]): ClassDecorator & MethodDecorator {
  return declareOnChain(META_GUARDS_CLASS, META_GUARDS_METHOD, guards);
}

/** 拦截器/守卫共用的元数据条目形态（都是可解析的类/实例/函数） */
type ChainItem = InterceptorLike | GuardLike;

/** 类装饰器/方法装饰器的通用登记逻辑（拦截器与守卫共用） */
function declareOnChain(
  classMetaKey: string,
  methodMetaKey: string,
  items: ChainItem[],
): ClassDecorator & MethodDecorator {
  return (target: any, propertyKey?: string | symbol) => {
    if (propertyKey === undefined) {
      // 类装饰器：target 为构造函数
      const list: ChainItem[] = Reflect.getOwnMetadata(classMetaKey, target) ?? [];
      list.push(...items);
      Reflect.defineMetadata(classMetaKey, list, target);
    } else {
      // 方法装饰器：target 为原型
      const map: Record<string | symbol, ChainItem[]> =
        Reflect.getOwnMetadata(methodMetaKey, target) ?? {};
      map[propertyKey] = (map[propertyKey] ?? []).concat(items);
      Reflect.defineMetadata(methodMetaKey, map, target);
    }
  };
}

/**
 * 收集某控制器某动作应执行的拦截器（不含全局拦截器）。
 * 顺序：[控制器级（基类在前/外层，子类在内层）..., 动作级（同规则）...]。
 */
export function collectInterceptors(
  ctor: any,
  actionName: string,
): InterceptorLike[] {
  return collectFromChain<InterceptorLike>(ctor, actionName, META_INTERCEPTORS_CLASS, META_INTERCEPTORS_METHOD);
}

/**
 * 收集某控制器某动作应执行的守卫（不含全局守卫）。
 * 顺序与 collectInterceptors 相同：控制器级在前，动作级在后。
 */
export function collectGuards(
  ctor: any,
  actionName: string,
): GuardLike[] {
  return collectFromChain<GuardLike>(ctor, actionName, META_GUARDS_CLASS, META_GUARDS_METHOD);
}

/** 沿原型链收集类级 + 方法级元数据（拦截器/守卫共用）；基类在外层、子类在内层 */
function collectFromChain<T extends ChainItem>(
  ctor: any,
  actionName: string,
  classMetaKey: string,
  methodMetaKey: string,
): T[] {
  const classLevel: T[] = [];
  let c: any = ctor;
  while (typeof c === 'function' && c && c !== Object) {
    const own = Reflect.getOwnMetadata(classMetaKey, c) as T[] | undefined;
    if (own) classLevel.push(...own);
    c = Object.getPrototypeOf(c);
  }
  classLevel.reverse();

  const methodLevel: T[] = [];
  let p: any = ctor.prototype;
  while (p && p !== Object.prototype) {
    const map = Reflect.getOwnMetadata(methodMetaKey, p) as
      | Record<string | symbol, T[]>
      | undefined;
    // 动作方法约定命名为 xxxAction，而路由动作名不含后缀，两种键都兼容
    const own = map?.[actionName] ?? map?.[`${actionName}Action`];
    if (own) methodLevel.push(...own);
    p = Object.getPrototypeOf(p);
  }
  methodLevel.reverse();

  return [...classLevel, ...methodLevel];
}
