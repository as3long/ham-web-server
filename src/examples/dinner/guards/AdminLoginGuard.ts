import { Injectable } from '../../../container/decorators';
import { Guard } from '../../../core/guard';
import { Context } from '../../../core/Context';
import { ACTION, SESSION_KEY } from '../constants';

/**
 * 类级守卫：保护点餐系统管理后台。
 *
 * 挂在 AdminController 类上，默认拦截该控制器的全部动作；
 * 登录动作（login）必须豁免，否则“未登录 -> 重定向登录页”会无限循环 ——
 * 守卫通过 ctx.action 识别当前动作。这演示了类级守卫 + 动作豁免的典型组合。
 */
@Injectable()
export class AdminLoginGuard implements Guard {
  canActivate(ctx: Context): boolean {
    if (ctx.action === ACTION.LOGIN) return true; // 登录页本身放行，避免重定向循环
    if (ctx.session.data[SESSION_KEY.ADMIN] === true) return true;
    ctx.redirect('/dinner-admin/login');
    return false;
  }
}
