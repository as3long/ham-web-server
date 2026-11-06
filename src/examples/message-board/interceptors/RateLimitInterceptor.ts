import { Injectable, Inject } from '../../../container/decorators';
import { Interceptor, Next } from '../../../core/interceptor';
import { Context } from '../../../core/Context';
import { isLoggedIn } from '../guards/LoginGuards';
import { HTTP_STATUS } from '../../../constants';
import { RATE_LIMIT_BUCKET_LIMIT, SESSION_KEY, TOKEN } from '../constants';

/** 限流配置（由应用通过 registerValue(TOKEN.RATE_LIMIT, ...) 注入） */
export interface RateLimitOptions {
  /** 时间窗口内允许的最大请求数 */
  max: number;
  /** 时间窗口长度（毫秒） */
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * 动作级拦截器：内存版固定窗口限流（key = 客户端 IP）。
 *
 * 超过阈值返回 429 并短路，动作不再执行。
 * 管理员（会话 isAdmin=true）不受限流 —— 守卫在拦截器之前已确认登录态，
 * 拦截器读会话即可拿到身份。
 * 单机内存实现，多实例部署时可替换为 Redis 等外部存储 —— 拦截器
 * 经 IoC 解析，只需换一个实现类并重新绑定即可。
 */
@Injectable()
export class RateLimitInterceptor implements Interceptor {
  private readonly buckets = new Map<string, Bucket>();

  constructor(@Inject(TOKEN.RATE_LIMIT) private options: RateLimitOptions) {}

  async intercept(ctx: Context, next: Next): Promise<void> {
    if (!ctx.isPost) return next(); // 只限流写操作
    if (isLoggedIn(ctx) && ctx.session.data[SESSION_KEY.IS_ADMIN] === true) return next(); // 管理员豁免

    const ip = ctx.raw.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const bucket = this.buckets.get(ip);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(ip, { count: 1, resetAt: now + this.options.windowMs });
    } else if (++bucket.count > this.options.max) {
      ctx.status(HTTP_STATUS.TOO_MANY_REQUESTS);
      ctx.echo(
        { ok: false, error: '操作过于频繁，请稍后再试' },
        HTTP_STATUS.TOO_MANY_REQUESTS,
      );
      return; // 短路：动作不会执行
    }

    // 桶数量超阈值时顺手清理过期项，避免长期运行内存膨胀
    if (this.buckets.size > RATE_LIMIT_BUCKET_LIMIT) {
      for (const [key, b] of this.buckets) {
        if (b.resetAt <= now) this.buckets.delete(key);
      }
    }
    return next();
  }
}
