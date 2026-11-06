import { BaseController } from '../../../controller/BaseController';
import { Controller } from '../../../container/decorators';
import { Context } from '../../../core/Context';

/** 首页直接跳转到留言板 */
@Controller('index')
export class IndexController extends BaseController {
  constructor(ctx: Context) {
    super(ctx);
  }

  async indexAction() {
    this.redirect('/board/');
  }
}
