import { BaseController } from '../../../controller/BaseController';
import { Autowired, Controller } from '../../../container/decorators';
import { Context } from '../../../core/Context';
import { TimeService } from '../services/TimeService';
import { UserService } from '../services/UserService';
import { TOKEN } from '../constants';

/**
 * 首页控制器。
 * - 构造函数注入：Context（请求作用域）、TimeService/UserService（单例）
 * - @Autowired：属性注入（这里用字符串令牌取 registerValue 注册的常量）
 */
@Controller('index')
export class IndexController extends BaseController {
  @Autowired(TOKEN.APP_VERSION)
  private version!: string;

  constructor(
    ctx: Context,
    private time: TimeService,
    private users: UserService,
  ) {
    super(ctx);
  }

  /** GET / —— 渲染模板 */
  async indexAction() {
    const count = await this.users.count();
    this.assign({
      version: this.version,
      now: this.time.now(),
      userCount: count,
    });
    this.display('index');
  }

  /** GET /index/time —— 动作直接返回对象时框架自动输出 JSON */
  async timeAction() {
    return { now: this.time.now(), uptime: this.time.uptime() };
  }
}
