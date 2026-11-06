import { Injectable, Inject } from '../../../container/decorators';
import { Guard } from '../../../core/guard';
import { Context } from '../../../core/Context';
import { TOKEN } from '../constants';

/**
 * 控制器级守卫：拉黑 IP 名单（黑名单内容经 @Inject(TOKEN.BANNED_IPS) 注入）。
 *
 * - 仅拦写操作（POST），浏览不受影响
 * - 命中黑名单时返回 false 且不自行响应 -> 框架输出默认 403 文本
 * - 单机名单用内存数组演示；真实场景可换成 Redis/数据库查询，
 *   守卫经 IoC 解析，替换实现只需改注册，不改控制器。
 */
@Injectable()
export class BannedIpGuard implements Guard {
  constructor(@Inject(TOKEN.BANNED_IPS) private banned: string[]) {}

  canActivate(ctx: Context): boolean {
    if (!ctx.isPost || this.banned.length === 0) return true;
    const ip = ctx.raw.socket.remoteAddress ?? '';
    return !this.banned.includes(ip);
  }
}
