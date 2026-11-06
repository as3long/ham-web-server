import { Injectable } from '../../../container/decorators';
import { Guard } from '../../../core/guard';
import { Context } from '../../../core/Context';
import { isLoggedIn } from './LoginGuards';
import { SESSION_KEY } from '../constants';

/**
 * 动作级守卫：管理员专属。
 *
 * - 未登录  -> 302 登录页（浏览器交互优先）
 * - 非管理员 -> 返回 false 且不自行响应 -> 框架默认 403
 *
 * 管理员标志存在会话中（登录时由 UserRow.isAdmin 写入），
 * 守卫只做判断：谁是管理员、怎么成为管理员，都是 User/Session 层的事。
 */
@Injectable()
export class AdminGuard implements Guard {
  canActivate(ctx: Context): boolean {
    if (!isLoggedIn(ctx)) {
      ctx.redirect('/board/login');
      return false;
    }
    return ctx.session.data[SESSION_KEY.IS_ADMIN] === true;
  }
}
