import { Injectable } from '../../../container/decorators';
import { Database } from '../../../database/Database';
import { DishRow, MenuService } from './MenuService';
import {
  CENTS_PER_YUAN,
  MAX_ITEM_QUANTITY,
  ORDER_NO_BASE,
  ORDER_NO_PREFIX,
  ORDER_STATUS,
  ORDER_STATUS_FLOW,
  ORDER_STATUS_TEXT,
  OrderStatus,
  RECENT_ORDER_LIMIT,
  TABLE,
} from '../constants';

export interface OrderRow {
  id: number;
  /** 取餐号：N1000 + 自增 id */
  orderNo: string;
  customer: string;
  tableNo: string;
  /** 0 待接单 / 1 制作中 / 2 已完成 / 3 已取消 */
  status: number;
  /** 总价，单位：分 */
  totalPrice: number;
  createdAt: number;
}

export interface OrderItemRow {
  id: number;
  orderId: number;
  dishId: number;
  /** 下单时的菜名/价格快照（菜品后续改名改价不影响历史订单） */
  dishName: string;
  price: number;
  quantity: number;
}

/** 展示用：附加金额元字符串与状态文案 */
export interface OrderView extends OrderRow {
  totalYuan: string;
  statusText: string;
  items: (OrderItemRow & { priceYuan: string; subtotalYuan: string })[];
}

/**
 * 订单服务：下单（事务）、取餐号、状态机流转。
 *
 * 状态机：待接单 -> 制作中 -> 已完成；仅“待接单”可取消。
 * 订单项保存菜名/价格快照，历史订单不受菜单后续变更影响。
 */
@Injectable()
export class OrderService {
  constructor(
    private db: Database,
    private menu: MenuService,
  ) {}

  async ensureTable(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS ham_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orderNo TEXT NOT NULL DEFAULT '',
        customer TEXT NOT NULL DEFAULT '顾客',
        tableNo TEXT NOT NULL DEFAULT '',
        status INTEGER NOT NULL DEFAULT 0,
        totalPrice INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL DEFAULT 0
      )
    `);
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS ham_order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orderId INTEGER NOT NULL DEFAULT 0,
        dishId INTEGER NOT NULL DEFAULT 0,
        dishName TEXT NOT NULL DEFAULT '',
        price INTEGER NOT NULL DEFAULT 0,
        quantity INTEGER NOT NULL DEFAULT 1
      )
    `);
  }

  /**
   * 提交订单：服务端按当前菜单价格重新计价（不信任客户端），整体放入事务。
   * 返回订单行；购物车为空或含不可售菜品时抛错（由控制器转为用户提示）。
   */
  async createOrder(
    cart: Array<{ dishId: number; quantity: number }>,
    customer: string,
    tableNo: string,
  ): Promise<OrderRow> {
    const dishes = await this.menu.availableByIds(cart.map((c) => c.dishId));
    if (dishes.length === 0) throw new Error('购物车为空或菜品均已下架');
    const byId = new Map(dishes.map((d) => [d.id, d]));
    const lines = cart
      .map((c) => ({ dish: byId.get(c.dishId), quantity: c.quantity }))
      .filter((l): l is { dish: DishRow; quantity: number } =>
        !!l.dish && l.quantity > 0 && l.quantity <= MAX_ITEM_QUANTITY);
    if (lines.length === 0) throw new Error('购物车为空');

    const totalPrice = lines.reduce((sum, l) => sum + l.dish.price * l.quantity, 0);

    // SQLite 用 BEGIN IMMEDIATE 串行化写入；MySQL 用 START TRANSACTION。
    // 取餐号基于 insertId 生成，避免多进程并发时 count()+1 产生重复号。
    const beginSql = this.db.cfg.dbType === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN';
    this.db.exec(beginSql);
    try {
      const inserted = await this.db.table<OrderRow>(TABLE.ORDERS).add({
        orderNo: '', // 占位，拿到 insertId 后再生成
        customer: customer.trim() || '顾客',
        tableNo: tableNo.trim(),
        status: ORDER_STATUS.PENDING,
        totalPrice,
        createdAt: Date.now(),
      } as Partial<OrderRow>);
      const orderId = inserted.insertId;
      const orderNo = `${ORDER_NO_PREFIX}${ORDER_NO_BASE + orderId}`;
      await this.db
        .table<OrderRow>(TABLE.ORDERS)
        .where({ id: orderId })
        .update({ orderNo } as Partial<OrderRow>);
      for (const line of lines) {
        await this.db.table<OrderItemRow>(TABLE.ORDER_ITEMS).add({
          orderId,
          dishId: line.dish.id,
          dishName: line.dish.name,
          price: line.dish.price,
          quantity: line.quantity,
        } as Partial<OrderItemRow>);
      }
      this.db.exec('COMMIT');
      return (await this.byId(orderId))!;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async byId(id: number): Promise<OrderRow | null> {
    return this.db.table<OrderRow>(TABLE.ORDERS).where({ id }).find();
  }

  async byNo(orderNo: string): Promise<OrderRow | null> {
    return this.db.table<OrderRow>(TABLE.ORDERS).where({ orderNo }).find();
  }

  /** 管理后台：最近的订单（新单在前） */
  async recent(limit = RECENT_ORDER_LIMIT): Promise<OrderRow[]> {
    return this.db
      .table<OrderRow>(TABLE.ORDERS)
      .order('id', 'DESC')
      .limit(limit)
      .select();
  }

  /**
   * 状态机流转：0->1 接单 / 0->3 取消 / 1->2 出餐；其余流转一律拒绝。
   */
  async setStatus(id: number, to: number): Promise<string | null> {
    const order = await this.byId(id);
    if (!order) return '订单不存在';
    if (!(ORDER_STATUS_FLOW[order.status] ?? []).includes(to)) {
      return `不允许的操作：${ORDER_STATUS_TEXT[order.status as OrderStatus]} -> ${
        ORDER_STATUS_TEXT[to as OrderStatus] ?? to
      }`;
    }
    await this.db
      .table<OrderRow>(TABLE.ORDERS)
      .where({ id })
      .update({ status: to } as Partial<OrderRow>);
    return null;
  }

  /** 订单 + 明细（含展示字段） */
  async detail(order: OrderRow): Promise<OrderView> {
    const items = await this.db
      .table<OrderItemRow>(TABLE.ORDER_ITEMS)
      .where({ orderId: order.id })
      .order('id', 'ASC')
      .select();
    return {
      ...order,
      totalYuan: (order.totalPrice / CENTS_PER_YUAN).toFixed(2),
      statusText:
        ORDER_STATUS_TEXT[order.status as OrderStatus] ?? String(order.status),
      items: items.map((it) => ({
        ...it,
        priceYuan: (it.price / CENTS_PER_YUAN).toFixed(2),
        subtotalYuan: ((it.price * it.quantity) / CENTS_PER_YUAN).toFixed(2),
      })),
    };
  }
}
