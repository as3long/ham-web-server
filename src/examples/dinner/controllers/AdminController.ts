import { timingSafeEqual } from 'crypto';
import { BaseController } from '../../../controller/BaseController';
import { Controller, Inject, UseGuards } from '../../../container/decorators';
import { Context } from '../../../core/Context';
import { DishRow, DishView, MenuService } from '../services/MenuService';
import { OrderService } from '../services/OrderService';
import { AdminLoginGuard } from '../guards/AdminLoginGuard';
import {
  CENTS_PER_YUAN,
  ORDER_STATUS,
  ORDER_STATUS_TEXT,
  RECENT_ORDER_LIMIT,
  SESSION_KEY,
  TOKEN,
} from '../constants';

/**
 * 管理侧控制器：订单管理 / 菜品管理。
 *
 *   GET  /dinner-admin/            订单管理（最近订单 + 状态流转按钮）
 *   GET/POST /dinner-admin/login   店主登录（共享口令，环境变量 DINNER_ADMIN_PASSWORD 覆盖）
 *   GET  /dinner-admin/logout      登出
 *   POST /dinner-admin/orderStatus 订单状态流转（orderId, to）
 *   GET  /dinner-admin/dishes      菜品管理（?edit=5 时表单预填该菜品）
 *   POST /dinner-admin/dishSave    新增/保存菜品（id=0 为新增）
 *   POST /dinner-admin/dishToggle  上架/下架
 *   POST /dinner-admin/dishDelete  删除菜品
 *
 * 整个控制器由类级 @UseGuards(AdminLoginGuard) 保护（login 动作在守卫内豁免）。
 */
@Controller('dinner-admin')
@UseGuards(AdminLoginGuard)
export class AdminController extends BaseController {
  constructor(
    ctx: Context,
    private menu: MenuService,
    private orders: OrderService,
    @Inject(TOKEN.ADMIN_PASSWORD) private adminPassword: string,
  ) {
    super(ctx);
  }

  /** 店主登录 */
  async loginAction() {
    if (this.ctx.isPost) {
      const password = String(this.post('password') ?? '');
      const expected = Buffer.from(this.adminPassword);
      const actual = Buffer.from(password);
      const ok = expected.length === actual.length && timingSafeEqual(actual, expected);
      if (!ok) {
        return this.redirect('/dinner-admin/login?error=' + encodeURIComponent('口令不正确'));
      }
      this.ctx.session.data[SESSION_KEY.ADMIN] = true;
      return this.redirect('/dinner-admin/');
    }
    this.assign({ error: this.get('error') ?? '' });
    this.display('dinner/admin-login');
  }

  async logoutAction() {
    this.ctx.session.data[SESSION_KEY.ADMIN] = false;
    this.redirect('/dinner-admin/login');
  }

  /** 订单管理：最近订单 + 状态流转 */
  async indexAction() {
    const rows = await this.orders.recent(RECENT_ORDER_LIMIT);
    const list = [];
    for (const row of rows) {
      list.push({
        ...(await this.orders.detail(row)),
        isPending: row.status === ORDER_STATUS.PENDING,
        isCooking: row.status === ORDER_STATUS.COOKING,
      });
    }
    this.assign({
      list,
      error: this.get('error') ?? '',
      ORDER_STATUS: ORDER_STATUS_TEXT,
    });
    this.display('dinner/admin');
  }

  /** 订单状态流转（非法流转会得到错误提示） */
  async orderStatusAction() {
    if (!this.ctx.isPost) return this.redirect('/dinner-admin/');
    const orderId = Number(this.post('orderId')) || 0;
    const to = Number(this.post('to'));
    const err = await this.orders.setStatus(orderId, to);
    if (err) return this.redirect('/dinner-admin/?error=' + encodeURIComponent(err));
    this.redirect('/dinner-admin/');
  }

  /** 菜品管理（?edit=id 时表单预填该菜品） */
  async dishesAction() {
    const editId = Number(this.get('edit')) || 0;
    const editing = editId > 0 ? await this.menu.byId(editId) : null;
    this.assign({
      list: (await this.menu.all()).map(withView),
      editing,
      error: this.get('error') ?? '',
    });
    this.display('dinner/admin-dishes');
  }

  /** 新增/保存菜品：价格以元输入、分存储 */
  async dishSaveAction() {
    if (!this.ctx.isPost) return this.redirect('/dinner-admin/dishes');
    const err = await this.menu.save({
      id: Number(this.post('id')) || 0,
      name: String(this.post('name') ?? ''),
      category: String(this.post('category') ?? ''),
      priceYuan: String(this.post('priceYuan') ?? ''),
      description: String(this.post('description') ?? ''),
    });
    if (err) return this.redirect('/dinner-admin/dishes?error=' + encodeURIComponent(err));
    this.redirect('/dinner-admin/dishes');
  }

  async dishToggleAction() {
    await this.menu.toggle(Number(this.post('id')) || 0);
    this.redirect('/dinner-admin/dishes');
  }

  async dishDeleteAction() {
    await this.menu.remove(Number(this.post('id')) || 0);
    this.redirect('/dinner-admin/dishes');
  }
}

function withView(dish: DishRow): DishView {
  return { ...dish, priceYuan: (dish.price / CENTS_PER_YUAN).toFixed(2) };
}
