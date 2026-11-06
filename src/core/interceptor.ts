import type { Context } from './Context';
import type { Type } from '../types';
import type { Container } from '../container/Container';

/** 拦截器：包裹 MVC 请求处理过程（洋葱模型） */
export interface Interceptor {
  intercept(ctx: Context, next: Next): Promise<void>;
}

export type Next = () => Promise<void>;

/** 函数式拦截器：轻量场景不想定义类时使用 */
export type FunctionalInterceptor = (ctx: Context, next: Next) => Promise<void>;

/** 拦截器的三种形态：类（经 IoC 解析）、实例、函数 */
export type InterceptorLike = Type<Interceptor> | Interceptor | FunctionalInterceptor;

/**
 * 洋葱模型组合：interceptors 按顺序构成层层外皮，final 是最内层的动作处理器。
 *
 * - 短路：拦截器不调用 next()、自行响应即可终止后续处理
 * - 错误：final 或内层抛出的错误沿 await next() 向外传播，外层可 try/catch
 * - next() 在同一拦截器中被调用多次会抛错（防止链路混乱）
 */
export function compose(
  interceptors: Interceptor[],
  final: Next,
): (ctx: Context) => Promise<void> {
  return (ctx) => {
    let index = -1;
    const dispatch = (i: number): Promise<void> => {
      if (i <= index) {
        return Promise.reject(new Error('[ham-aop] next() 在同一个拦截器中被调用了多次'));
      }
      index = i;
      if (i === interceptors.length) return final();
      return Promise.resolve(interceptors[i].intercept(ctx, () => dispatch(i + 1)));
    };
    return dispatch(0);
  };
}

/**
 * 将 InterceptorLike 归一化为 Interceptor 实例。
 * 类形式通过 IoC 容器解析（singleton/transient/request 作用域均有效，可注入服务）；
 * 函数式形式包装为 Interceptor 对象。
 */
export function toInterceptor(like: InterceptorLike, container: Container): Interceptor {
  if (typeof like === 'function') {
    const proto = (like as Type<Interceptor>).prototype;
    if (proto && typeof proto.intercept === 'function') {
      return container.resolve(like as Type<Interceptor>);
    }
    const fn = like as FunctionalInterceptor;
    return { intercept: (ctx, next) => fn(ctx, next) };
  }
  if (like && typeof like.intercept === 'function') {
    return like;
  }
  throw new Error(
    '[ham-aop] 无效的拦截器：需要实现 Interceptor 的类/实例，或 (ctx, next) => Promise 函数',
  );
}
