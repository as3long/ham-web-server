import { BaseController } from '../../../controller/BaseController';
import { Controller } from '../../../container/decorators';
import { Context } from '../../../core/Context';
import { UserService } from '../services/UserService';
import { HTTP_STATUS } from '../../../constants';
import { USER_LIST_LIMIT } from '../constants';

/**
 * 用户控制器：演示表单处理、会话、路径参数。
 *
 *   GET  /user          用户列表（含会话计数）
 *   GET  /user/add      添加用户表单
 *   POST /user/add      提交用户
 *   GET  /user/api/5    JSON 接口（路径参数）
 */
@Controller('user')
export class UserController extends BaseController {
  constructor(
    ctx: Context,
    private users: UserService,
  ) {
    super(ctx);
  }

  async indexAction() {
    // 会话数据直接读写（Cookie 已默认 HttpOnly）
    this.session.viewCount = (this.session.viewCount ?? 0) + 1;
    const users = await this.users.list(USER_LIST_LIMIT);
    this.assign({ users, viewCount: this.session.viewCount });
    this.display('user/list');
  }

  async addAction() {
    if (this.ctx.isPost) {
      const name = (this.post('name') ?? '').trim();
      const email = (this.post('email') ?? '').trim();
      if (!name) {
        return { ok: false, error: 'name 不能为空' };
      }
      await this.users.add(name, email);
      return this.redirect('/user/');
    }
    this.display('user/add');
  }

  /** 路径参数：/user/api/5 -> apiAction('5') */
  async apiAction(id?: string) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId)) {
      this.ctx.status(HTTP_STATUS.BAD_REQUEST);
      return { ok: false, error: 'id 必须是整数' };
    }
    const user = await this.users.find(numericId);
    if (!user) {
      this.ctx.status(HTTP_STATUS.NOT_FOUND);
      return { ok: false, error: '用户不存在' };
    }
    return { ok: true, user };
  }
}
