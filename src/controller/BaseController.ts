import { Context } from '../core/Context';
import { ViewEngine } from '../view/ViewEngine';
import { Autowired } from '../container/decorators';
import { UploadedFile } from '../types';
import { HTTP_STATUS } from '../constants';

/**
 * 控制器基类。每个请求都会通过 IoC 容器创建新的控制器实例（修复 1.x
 * 中控制器实例跨请求复用导致的状态污染问题）。
 *
 * 用法：
 * ```ts
 * @Controller('user')
 * export class UserController extends BaseController {
 *   constructor(ctx: Context, private users: UserService) { super(ctx); }
 *
 *   async indexAction() {
 *     this.assign('users', await this.users.list());
 *     this.display('user/list');
 *   }
 * }
 * ```
 */
export abstract class BaseController {
  @Autowired(ViewEngine)
  protected view!: ViewEngine;

  protected tplData: Record<string, unknown> = {};

  constructor(public readonly ctx: Context) {}

  // ------------------------------------------------------------- 输入

  /** 查询参数 */
  protected get(key?: string) {
    return this.ctx.get(key as any);
  }

  /** POST 字段 */
  protected post(key?: string) {
    return this.ctx.post(key as any);
  }

  /** 上传文件 */
  protected files(key?: string): Record<string, UploadedFile> | UploadedFile | undefined {
    return this.ctx.files(key as any);
  }

  /** 会话数据（直接读写） */
  protected get session(): Record<string, any> {
    return this.ctx.session.data;
  }

  // ------------------------------------------------------------- 输出

  /** 设置模板变量：assign({...}) 或 assign('key', value) */
  protected assign(arg1: string | Record<string, unknown>, arg2?: unknown): this {
    if (typeof arg1 === 'string') {
      this.tplData[arg1] = arg2;
    } else {
      Object.assign(this.tplData, arg1);
    }
    return this;
  }

  /**
   * 渲染模板并输出。tplPath 缺省为 `<控制器>/<动作>`（与 1.x 一致）。
   */
  protected display(tplPath?: string, data?: Record<string, unknown>): void {
    const tpl = tplPath ?? `${this.ctx.controller}/${this.ctx.action}`;
    this.ctx.html(this.view.render(tpl, { ...this.tplData, ...data }));
  }

  /** 输出文本 / JSON */
  protected echo(data: unknown, statusCode: number = HTTP_STATUS.OK): void {
    this.ctx.echo(data, statusCode);
  }

  /** 输出 JSON（别名） */
  protected json(data: unknown, statusCode: number = HTTP_STATUS.OK): void {
    this.ctx.echo(data, statusCode);
  }

  /** URL 跳转 */
  protected redirect(url: string, code = 302): void {
    this.ctx.redirect(url, code);
  }
}
