import { Injectable } from '../../../container/decorators';
import { Interceptor, Next } from '../../../core/interceptor';
import { Context } from '../../../core/Context';
import {
  HTTP_HEADER,
  HTTP_STATUS,
  MIME_TYPE,
} from '../../../constants';

const CONTENT_TYPE_HEADER = HTTP_HEADER.CONTENT_TYPE.toLowerCase();

/**
 * 动作级拦截器：POST 请求必须是 application/json，否则返回 415 短路。
 *
 * 在进入动作、解析请求体之前就拒绝不合规请求，节省解析开销。
 */
@Injectable()
export class JsonOnlyInterceptor implements Interceptor {
  async intercept(ctx: Context, next: Next): Promise<void> {
    if (ctx.isPost) {
      const type = String(ctx.raw.headers[CONTENT_TYPE_HEADER] ?? '');
      if (!type.toLowerCase().includes(MIME_TYPE.JSON)) {
        ctx.status(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE);
        ctx.echo(
          { ok: false, error: '本接口仅接受 application/json 请求体' },
          HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
        );
        return; // 短路
      }
    }
    return next();
  }
}
