import { Injectable } from '../../../container/decorators';
import { Guard } from '../../../core/guard';
import { Context } from '../../../core/Context';
import { HTTP_STATUS } from '../../../constants';
import { SESSION_KEY } from '../constants';

/** 是否已登录（会话中记录了 userId） */
export function isLoggedIn(ctx: Context): boolean {
  return Number(ctx.session.data[SESSION_KEY.USER_ID]) > 0;
}

/**
 * 动作级守卫：未登录的“页面/表单”请求 302 到登录页。
 *
 * 用于 HTML 交互路径（浏览器体验优先）；守卫在动作与请求体解析之前执行，
 * 未登录请求连表单解析都不会发生。
 */
@Injectable()
export class FormLoginGuard implements Guard {
  canActivate(ctx: Context): boolean {
    if (isLoggedIn(ctx)) return true;
    ctx.redirect('/board/login');
    return false;
  }
}

/**
 * 动作级守卫：未登录的“JSON 接口”请求返回 401。
 *
 * 用于程序化调用方（fetch/axios），与 FormLoginGuard 同一规则、不同响应形态 ——
 * 框架对守卫只约定“放行/拒绝”，响应方式由守卫自行决定。
 */
@Injectable()
export class ApiLoginGuard implements Guard {
  canActivate(ctx: Context): boolean {
    if (isLoggedIn(ctx)) return true;
    ctx.status(HTTP_STATUS.UNAUTHORIZED);
    ctx.echo(
      { ok: false, error: '请先登录后再留言' },
      HTTP_STATUS.UNAUTHORIZED,
    );
    return false;
  }
}
