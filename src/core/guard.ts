import type { Context } from './Context';
import type { Type } from '../types';
import type { Container } from '../container/Container';

/**
 * 守卫：决定请求是否放行（鉴权/授权类横切逻辑）。
 *
 * 与拦截器的分工：守卫回答“能不能进”（先于拦截器与请求体解析执行），
 * 拦截器回答“进出时做什么”（日志/限流/追踪，洋葱模型包裹动作）。
 */
export interface Guard {
  canActivate(ctx: Context): boolean | Promise<boolean>;
}

/** 函数式守卫：轻量场景不想定义类时使用 */
export type FunctionalGuard = (ctx: Context) => boolean | Promise<boolean>;

/** 守卫的三种形态：类（经 IoC 解析）、实例、函数 */
export type GuardLike = Type<Guard> | Guard | FunctionalGuard;

/**
 * 依次执行守卫：全局 -> 控制器级 -> 动作级 顺序传入，全部通过才放行。
 * 任一守卫返回 false 立即短路（后续守卫不再执行）。
 *
 * 拒绝时的响应：守卫可先自行响应（ctx.echo / ctx.redirect）再返回 false，
 * 框架只在“未写入任何响应”时兜底输出默认 403。
 */
export async function canAllActivate(guards: Guard[], ctx: Context): Promise<boolean> {
  for (const guard of guards) {
    if (!(await guard.canActivate(ctx))) return false;
  }
  return true;
}

/**
 * 将 GuardLike 归一化为 Guard 实例。
 * 类形式通过 IoC 容器解析（singleton/transient/request 作用域均有效，可注入服务）；
 * 函数式形式包装为 Guard 对象。
 */
export function toGuard(like: GuardLike, container: Container): Guard {
  if (typeof like === 'function') {
    const proto = (like as Type<Guard>).prototype;
    if (proto && typeof proto.canActivate === 'function') {
      return container.resolve(like as Type<Guard>);
    }
    const fn = like as FunctionalGuard;
    return { canActivate: (ctx) => fn(ctx) };
  }
  if (like && typeof like.canActivate === 'function') {
    return like;
  }
  throw new Error(
    '[ham-guard] 无效的守卫：需要实现 Guard 的类/实例，或 (ctx) => boolean | Promise<boolean> 函数',
  );
}
