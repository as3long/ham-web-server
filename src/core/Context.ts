import { IncomingMessage, ServerResponse } from 'http';
import { HamConfig, PostData, Session, UploadedFile } from '../types';
import { parseBody as parseRequestBody } from './body';
import {
  CONTENT_TYPE,
  HTTP_HEADER,
  HTTP_METHOD,
  HTTP_STATUS,
} from '../constants';

/**
 * 请求上下文：封装 req/res/query/cookies/body/session。
 * 属于 request 作用域，可直接注入控制器构造函数。
 */
export class Context {
  readonly query: Record<string, string>;
  readonly cookies: Record<string, string | undefined>;
  readonly method: string;
  readonly isGet: boolean;
  readonly isPost: boolean;
  readonly startDate = Date.now();
  /** 请求追踪 ID（由框架生成或透传 X-Request-Id） */
  readonly requestId: string;

  /** 由路由器填写的控制器/动作名（用于 display 默认模板） */
  controller = '';
  action = '';

  /** 重定向后为 true，框架据此终止后续处理 */
  redirected = false;

  private body?: PostData;

  constructor(
    readonly raw: IncomingMessage,
    readonly res: ServerResponse,
    readonly config: HamConfig,
    readonly url: URL,
    readonly session: Session,
    private readonly appPath: string,
    requestId = '',
  ) {
    this.requestId = requestId;
    this.method = (raw.method || HTTP_METHOD.GET).toUpperCase();
    this.isGet = this.method === HTTP_METHOD.GET;
    this.isPost = this.method === HTTP_METHOD.POST;
    this.query = Object.fromEntries(url.searchParams);
    this.cookies = parseRequestCookies(raw.headers.cookie);
  }

  /** 查询参数；不传 key 返回全部 */
  get(): Record<string, string>;
  get(key: string): string | undefined;
  get(key?: string): string | Record<string, string> | undefined {
    return key === undefined ? this.query : this.query[key];
  }

  /** POST 字段；不传 key 返回全部 */
  post(): Record<string, string>;
  post(key: string): string | undefined;
  post(key?: string): string | Record<string, string> | undefined {
    const fields = this.body?.fields ?? {};
    return key === undefined ? fields : fields[key];
  }

  /** 上传文件；不传 key 返回全部 */
  files(): Record<string, UploadedFile>;
  files(key: string): UploadedFile | undefined;
  files(key?: string): Record<string, UploadedFile> | UploadedFile | undefined {
    const files = this.body?.files ?? {};
    return key === undefined ? files : files[key];
  }

  /** 惰性解析请求体（POST 时由框架自动调用） */
  async parseBody(): Promise<PostData> {
    if (!this.body) {
      this.body = await parseRequestBody(this.raw, this.config, this.appPath);
    }
    return this.body;
  }

  /** 设置响应状态码 */
  status(code: number): this {
    this.res.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.res.setHeader(name, value);
    return this;
  }

  /** 输出 HTML */
  html(body: string, statusCode: number = HTTP_STATUS.OK): void {
    this.send(statusCode, CONTENT_TYPE.HTML, body);
  }

  /**
   * 输出文本或 JSON：字符串按 text/plain，其他类型 JSON 序列化。
   */
  echo(data: unknown, statusCode: number = HTTP_STATUS.OK): void {
    if (typeof data === 'string') {
      this.send(statusCode, CONTENT_TYPE.TEXT, data);
    } else {
      this.send(statusCode, CONTENT_TYPE.JSON, JSON.stringify(data));
    }
  }

  /** URL 跳转 */
  redirect(url: string, code: number = HTTP_STATUS.FOUND): void {
    this.res.writeHead(code, { [HTTP_HEADER.LOCATION]: url || '/' });
    this.res.end();
    this.redirected = true;
  }

  /** 本次请求耗时（毫秒） */
  get useTime(): number {
    return Date.now() - this.startDate;
  }

  private send(statusCode: number, type: string, body: string): void {
    if (this.res.writableEnded || this.redirected) return;
    this.res.writeHead(statusCode, {
      [HTTP_HEADER.CONTENT_TYPE]: type,
      [HTTP_HEADER.USE_TIME]: `${this.useTime}ms`,
    });
    this.res.end(body);
  }
}

function parseRequestCookies(
  header?: string,
): Record<string, string | undefined> {
  const cookies: Record<string, string | undefined> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return cookies;
}
