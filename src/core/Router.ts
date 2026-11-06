import { Type } from '../types';
import { META_CONTROLLER } from '../container/decorators';
import {
  DEFAULT_ACTION,
  DEFAULT_CONTROLLER,
  DEFAULT_HOST,
} from '../constants';

export interface RouteMatch {
  controller: string;
  action: string;
  args: string[];
}

/**
 * 解析 ThinkPHP 风格的伪静态 URL：
 *   /user/list.html          -> user / list / []
 *   /user/api/5.html         -> user / api / ['5']
 *   /                        -> index / index / []
 *   /index/time?ts=1         -> index / time / []
 */
export function parseRoute(pathname: string): RouteMatch {
  const normalized = pathname.replace(/\.html/gi, '/');
  const parts = normalized.split('/').filter(Boolean);
  const [controller = DEFAULT_CONTROLLER, action = DEFAULT_ACTION, ...rest] = parts;
  let args: string[] = rest;
  try {
    args = rest.map((a) => decodeURIComponent(a));
  } catch {
    /* 保留原值 */
  }
  return { controller, action, args };
}

/**
 * 路由表：控制器名 -> 控制器类。
 */
export class Router {
  private routes = new Map<string, Type<any>>();

  /** 注册控制器。名字取 @Controller 元数据，缺省由类名推导。 */
  add(ctor: Type<any>): string {
    const meta = Reflect.getMetadata(META_CONTROLLER, ctor) as
      | { name: string }
      | undefined;
    const name = (meta?.name ?? defaultControllerName(ctor)).toLowerCase();
    this.routes.set(name, ctor);
    return name;
  }

  find(name: string): Type<any> | undefined {
    return this.routes.get(name.toLowerCase());
  }

  all(): Map<string, Type<any>> {
    return this.routes;
  }

  /** 供测试/调试：静态解析 URL */
  static match(pathname: string): RouteMatch {
    return parseRoute(new URL(pathname, `http://${DEFAULT_HOST}`).pathname);
  }
}

function defaultControllerName(ctor: Type<any>): string {
  const name = ctor.name.replace(/Controller$/, '');
  if (!name) {
    throw new Error(`[ham-router] ${ctor.name} 未指定 @Controller('name') 且无法从类名推导`);
  }
  return name.toLowerCase();
}
