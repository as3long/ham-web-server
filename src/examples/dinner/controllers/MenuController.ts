import { BaseController } from '../../../controller/BaseController';
import { Controller } from '../../../container/decorators';
import { Context } from '../../../core/Context';
import { DishRow, DishView, MenuService } from '../services/MenuService';
import { OrderView, OrderService } from '../services/OrderService';
import { HTTP_STATUS } from '../../../constants';
import {
  AVAILABILITY,
  CENTS_PER_YUAN,
  MAX_ITEM_QUANTITY,
  SESSION_KEY,
} from '../constants';

type CartMap = Record<string, number>;

/**
 * 顾客侧控制器：菜单 / 购物车（会话存储）/ 下单 / 取餐。
 *
 *   GET  /dinner/            菜单（按分类分组）
 *   GET  /dinner/cart        购物车
 *   POST /dinner/cartAdd     加入购物车（dishId）
 *   POST /dinner/cartUpdate  修改数量（dishId, qty，0 = 移除）
 *   POST /dinner/cartClear   清空购物车
 *   POST /dinner/orderSubmit 提交订单（customer, tableNo）-> 302 订单页
 *   GET  /dinner/order/5     订单详情（路径参数）；也支持 ?no=N1001 按取餐号查
 *
 * 购物车存在框架会话里（session.data.cart），纯服务端实现 —— 无需登录，
 * 换一个会话（换浏览器）就是另一桌客人。
 */
@Controller('dinner')
export class MenuController extends BaseController {
  constructor(
    ctx: Context,
    private menu: MenuService,
    private orders: OrderService,
  ) {
    super(ctx);
  }

  /** 菜单页 */
  async indexAction() {
    const groups = await this.menu.groupedMenu();
    const cart = await this.cartLines();
    this.assign({
      groups: groups.map((g) => ({ category: g.category, items: g.items.map(withPrice) })),
      cartCount: cart.reduce((s, l) => s + l.quantity, 0),
      cartTotalYuan: centsToYuan(cart.reduce((s, l) => s + l.price * l.quantity, 0)),
      added: this.get('added') ?? '',
      error: this.get('error') ?? '',
    });
    this.display('dinner/menu');
  }

  /** 购物车页（含下单表单） */
  async cartAction() {
    const cart = await this.cartLines();
    this.assign({
      cart,
      totalYuan: centsToYuan(cart.reduce((s, l) => s + l.price * l.quantity, 0)),
      error: this.get('error') ?? '',
    });
    this.display('dinner/cart');
  }

  /** 加入购物车：数量 +1（菜品必须处于上架状态）。加完留在菜单页，用锚点回到该菜品 */
  async cartAddAction() {
    const dishId = Number(this.post('dishId')) || 0;
    const dish = dishId > 0 ? await this.menu.byId(dishId) : null;
    if (!dish || dish.isAvailable !== AVAILABILITY.ON) {
      return this.redirect('/dinner/?error=' + encodeURIComponent('该菜品不可点，请刷新菜单'));
    }
    const cart = this.rawCart();
    cart[String(dishId)] = Math.min(
      MAX_ITEM_QUANTITY,
      (cart[String(dishId)] ?? 0) + 1,
    );
    this.saveCart(cart);
    this.redirect(`/dinner/?added=${encodeURIComponent(dish.name)}#dish-${dish.id}`);
  }

  /** 修改数量：qty=0 即移除 */
  async cartUpdateAction() {
    const dishId = Number(this.post('dishId')) || 0;
    const qty = Number(this.post('qty'));
    const cart = this.rawCart();
    if (dishId > 0 && qty > 0) {
      cart[String(dishId)] = Math.min(MAX_ITEM_QUANTITY, Math.floor(qty));
    }
    else delete cart[String(dishId)];
    this.saveCart(cart);
    this.redirect('/dinner/cart');
  }

  async cartClearAction() {
    this.saveCart({});
    this.redirect('/dinner/cart');
  }

  /** 提交订单：服务端计价 + 事务落库，成功后清空购物车并跳转取餐页 */
  async orderSubmitAction() {
    if (!this.ctx.isPost) return this.redirect('/dinner/cart');
    const cart = this.rawCart();
    const lines = Object.entries(cart).map(([dishId, quantity]) => ({ dishId: Number(dishId), quantity }));
    try {
      const order = await this.orders.createOrder(lines, String(this.post('customer') ?? ''), String(this.post('tableNo') ?? ''));
      this.saveCart({});
      this.redirect(`/dinner/order/${order.id}`);
    } catch (err: any) {
      return this.redirect('/dinner/cart?error=' + encodeURIComponent(err?.message ?? '下单失败'));
    }
  }

  /**
   * 订单详情 / 取餐页：/dinner/order/5（路径参数）或 /dinner/order?no=N1001（取餐号查询）。
   */
  async orderAction(orderId?: string) {
    const id = Number(orderId) || 0;
    const no = this.get('no') ?? '';
    const order = id > 0
      ? await this.orders.byId(id)
      : (no ? await this.orders.byNo(no) : null);
    if (!order) {
      this.ctx.status(HTTP_STATUS.NOT_FOUND);
      return this.echoNotFound();
    }
    const view = await this.orders.detail(order);
    this.assignOrder(view);
    this.display('dinner/order');
  }

  // ------------------------------------------------------------- 内部

  private rawCart(): CartMap {
    const cart = this.session[SESSION_KEY.CART];
    return cart && typeof cart === 'object' ? cart as CartMap : {};
  }

  private saveCart(cart: CartMap): void {
    this.ctx.session.data[SESSION_KEY.CART] = cart;
  }

  /** 会话购物车 -> 明细行（自动剔除已删除/下架的菜品） */
  private async cartLines(): Promise<Array<DishView & { quantity: number; subtotalYuan: string }>> {
    const cart = this.rawCart();
    const ids = Object.keys(cart).map(Number).filter((n) => n > 0);
    const dishes = await this.menu.availableByIds(ids);
    return dishes.map((d) => {
      const quantity = cart[String(d.id)] ?? 0;
      return {
        ...withPrice(d),
        quantity,
        subtotalYuan: ((d.price * quantity) / CENTS_PER_YUAN).toFixed(2),
      };
    });
  }

  private assignOrder(view: OrderView): void {
    this.assign({
      order: view,
      items: view.items,
      totalYuan: view.totalYuan,
      statusText: view.statusText,
    });
  }

  private echoNotFound(): void {
    this.ctx.echo('订单不存在，请核对取餐号', HTTP_STATUS.NOT_FOUND);
  }
}

/** 分 -> 元展示字段 */
function withPrice(dish: DishRow): DishView {
  return { ...dish, priceYuan: centsToYuan(dish.price) };
}

/** 分 -> 元字符串（金额一律以分为单位计算，仅展示时转元） */
function centsToYuan(cents: number): string {
  return (cents / CENTS_PER_YUAN).toFixed(2);
}
