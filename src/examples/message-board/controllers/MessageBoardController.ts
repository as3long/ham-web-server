import { BaseController } from '../../../controller/BaseController';
import { Controller, UseGuards, UseInterceptors } from '../../../container/decorators';
import { Context } from '../../../core/Context';
import { MessageService } from '../services/MessageService';
import { UserRow, UserService } from '../services/UserService';
import { RateLimitInterceptor } from '../interceptors/RateLimitInterceptor';
import { JsonOnlyInterceptor } from '../interceptors/JsonOnlyInterceptor';
import { FormLoginGuard, ApiLoginGuard } from '../guards/LoginGuards';
import { AdminGuard } from '../guards/AdminGuard';
import { BannedIpGuard } from '../guards/BannedIpGuard';
import { HTTP_STATUS } from '../../../constants';
import {
  ADMIN_FLAG,
  ANONYMOUS_NICKNAME,
  DEFAULT_PAGE_NO,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SESSION_KEY,
  TRUE_FLAG,
} from '../constants';

/**
 * 留言板控制器（含用户系统）。
 *
 *   GET  /board/              留言列表（?page=2 分页）；未登录只能看，不能发
 *   POST /board/add           发表留言 —— 需登录（FormLoginGuard）+ 限流（管理员豁免）
 *   GET  /board/api           JSON 分页接口
 *   POST /board/apiAdd        JSON 发表 —— 需登录（ApiLoginGuard）+ 仅收 JSON
 *   GET/POST /board/register  注册（用户表中第一个注册的用户自动成为管理员）
 *   GET/POST /board/login     登录
 *   GET  /board/logout        登出
 *   GET/POST /board/password  修改密码 —— 需登录
 *   POST /board/adminDelete   删除任意留言 —— 仅管理员（AdminGuard）
 *
 * 权限模型：守卫（能不能进）-> 拦截器（进出时做什么）-> 动作（业务）。
 */
@Controller('board')
@UseGuards(BannedIpGuard)
export class MessageBoardController extends BaseController {
  constructor(
    ctx: Context,
    private messages: MessageService,
    private users: UserService,
  ) {
    super(ctx);
  }

  // ------------------------------------------------------------- 留言

  /** 留言板主页 */
  async indexAction() {
    const pageNo = Number(this.get('page')) || DEFAULT_PAGE_NO;
    const data = await this.messages.pageList(pageNo);
    this.assign({
      ...data,
      user: this.str(SESSION_KEY.USERNAME),
      isAdmin: this.session[SESSION_KEY.IS_ADMIN] === true,
      posted: this.get('posted') === TRUE_FLAG,
      passwordChanged: this.get('passwordChanged') === TRUE_FLAG,
    });
    this.display('board/list');
  }

  /** 发表留言（表单）：未登录由 FormLoginGuard 拦下，昵称固定为登录账号 */
  @UseGuards(FormLoginGuard)
  @UseInterceptors(RateLimitInterceptor)
  async addAction() {
    if (!this.ctx.isPost) return this.redirect('/board/');
    const nickname = this.str(SESSION_KEY.USERNAME) || ANONYMOUS_NICKNAME;
    const content = (this.post('content') ?? '').trim();
    if (!content) return this.redirect('/board/'); // 空内容直接回列表
    await this.messages.add(nickname, content, this.clientIp(), this.isAdminFlag());
    this.redirect('/board/?posted=1');
  }

  /** JSON 分页接口 */
  async apiAction() {
    const pageNo = Number(this.get('page')) || DEFAULT_PAGE_NO;
    const size = Math.min(
      MAX_PAGE_SIZE,
      Math.max(DEFAULT_PAGE_NO, Number(this.get('size')) || DEFAULT_PAGE_SIZE),
    );
    const data = await this.messages.pageList(pageNo, size);
    return { ok: true, ...data };
  }

  /** JSON 发表接口：未登录 401（ApiLoginGuard），非 JSON 415（JsonOnlyInterceptor） */
  @UseGuards(ApiLoginGuard)
  @UseInterceptors(JsonOnlyInterceptor)
  async apiAddAction() {
    const nickname = this.str(SESSION_KEY.USERNAME) || ANONYMOUS_NICKNAME;
    const content = (this.post('content') ?? '').trim();
    if (!content) {
      this.ctx.status(HTTP_STATUS.BAD_REQUEST);
      return { ok: false, error: 'content 不能为空' };
    }
    const id = await this.messages.add(nickname, content, this.clientIp(), this.isAdminFlag());
    return { ok: true, id };
  }

  /** 删除任意留言（仅管理员；列表页管理员的删除按钮指向这里） */
  @UseGuards(AdminGuard)
  async adminDeleteAction() {
    const id = Number(this.post('id') ?? this.get('id')) || 0;
    if (id <= 0) {
      this.ctx.status(HTTP_STATUS.BAD_REQUEST);
      return { ok: false, error: 'id 无效' };
    }
    await this.messages.remove(id);
    this.redirect('/board/');
  }

  // ------------------------------------------------------------- 账号

  /** 注册（GET 表单 / POST 提交，成功后自动登录） */
  async registerAction() {
    if (this.ctx.isPost) {
      const username = (this.post('username') ?? '').trim();
      const password = String(this.post('password') ?? '');
      const confirm = String(this.post('confirm') ?? '');
      let err: string | null = null;
      if (password !== confirm) err = '两次输入的密码不一致';
      else err = await this.users.register(username, password);

      if (err) return this.redirect(`/board/register?error=${encodeURIComponent(err)}`);
      const user = await this.users.findByUsername(username);
      if (!user) return this.redirect('/board/register?error=注册失败，请重试');
      this.loginSession(user);
      return this.redirect('/board/');
    }
    this.assign({ error: this.get('error') ?? '' });
    this.display('board/register');
  }

  /** 登录 */
  async loginAction() {
    if (this.ctx.isPost) {
      const username = (this.post('username') ?? '').trim();
      const password = String(this.post('password') ?? '');
      const user = await this.users.verify(username, password);
      if (!user) {
        return this.redirect(`/board/login?error=${encodeURIComponent('用户名或密码错误')}`);
      }
      this.loginSession(user);
      return this.redirect('/board/');
    }
    this.assign({ error: this.get('error') ?? '' });
    this.display('board/login');
  }

  /** 登出：清空会话数据后回列表 */
  async logoutAction() {
    this.ctx.session.data = {};
    this.redirect('/board/');
  }

  /** 修改密码（需登录：FormLoginGuard；GET 表单 / POST 提交） */
  @UseGuards(FormLoginGuard)
  async passwordAction() {
    if (this.ctx.isPost) {
      const oldPassword = String(this.post('oldPassword') ?? '');
      const newPassword = String(this.post('newPassword') ?? '');
      const confirm = String(this.post('confirm') ?? '');
      let err: string | null = null;
      if (newPassword !== confirm) err = '两次输入的新密码不一致';
      else {
        err = await this.users.changePassword(
          Number(this.session[SESSION_KEY.USER_ID]),
          oldPassword,
          newPassword,
        );
      }
      if (err) return this.redirect(`/board/password?error=${encodeURIComponent(err)}`);
      return this.redirect('/board/?passwordChanged=1');
    }
    this.assign({
      error: this.get('error') ?? '',
      user: this.str(SESSION_KEY.USERNAME),
    });
    this.display('board/password');
  }

  // ------------------------------------------------------------- 内部

  /** 登录态写入会话（isAdmin 随用户信息一起进入会话，供守卫与模板使用） */
  private loginSession(user: UserRow): void {
    this.ctx.session.data[SESSION_KEY.USER_ID] = user.id;
    this.ctx.session.data[SESSION_KEY.USERNAME] = user.username;
    this.ctx.session.data[SESSION_KEY.IS_ADMIN] = user.isAdmin === ADMIN_FLAG.YES;
  }

  private str(key: string): string {
    return typeof this.session[key] === 'string' ? this.session[key] : '';
  }

  /** 发帖时的管理员标志（快照写入留言行，供列表徽标展示） */
  private isAdminFlag(): number {
    return this.session[SESSION_KEY.IS_ADMIN] === true
      ? ADMIN_FLAG.YES
      : ADMIN_FLAG.NO;
  }

  private clientIp(): string {
    return this.ctx.raw.socket.remoteAddress ?? '';
  }
}
