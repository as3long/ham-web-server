/** DI 令牌 */
export const TOKEN = {
  ADMIN_PASSWORD: 'DINNER_ADMIN_PASSWORD',
} as const;

/** 会话数据键 */
export const SESSION_KEY = {
  ADMIN: 'dinnerAdmin',
  CART: 'cart',
} as const;

/** 数据表名（QueryBuilder 会自动加 ham_ 前缀） */
export const TABLE = {
  ORDERS: 'orders',
  ORDER_ITEMS: 'order_items',
  DISHES: 'dishes',
} as const;

/** 订单状态 */
export const ORDER_STATUS = {
  PENDING: 0,
  COOKING: 1,
  DONE: 2,
  CANCELLED: 3,
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

/** 订单状态文案 */
export const ORDER_STATUS_TEXT: Record<OrderStatus, string> = {
  [ORDER_STATUS.PENDING]: '待接单',
  [ORDER_STATUS.COOKING]: '制作中',
  [ORDER_STATUS.DONE]: '已完成',
  [ORDER_STATUS.CANCELLED]: '已取消',
};

/** 合法状态流转：待接单 -> 制作中 / 已取消；制作中 -> 已完成 */
export const ORDER_STATUS_FLOW: Record<number, readonly number[]> = {
  [ORDER_STATUS.PENDING]: [ORDER_STATUS.COOKING, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.COOKING]: [ORDER_STATUS.DONE],
};

/** 取餐号：N + (1000 + 序号) */
export const ORDER_NO_PREFIX = 'N';
export const ORDER_NO_BASE = 1000;

/** 金额：以“分”为整数存储 */
export const CENTS_PER_YUAN = 100;
export const MAX_PRICE_YUAN = 9999;

/** 菜品 */
export const DEFAULT_CATEGORY = '招牌菜';
export const AVAILABILITY = { ON: 1, OFF: 0 } as const;
export const MAX_ITEM_QUANTITY = 99;

/** 后台列表 / 慢请求阈值 */
export const RECENT_ORDER_LIMIT = 30;
export const SLOW_REQUEST_MS = 200;

/** 店主默认口令（可被 DINNER_ADMIN_PASSWORD 环境变量覆盖） */
export const DEFAULT_ADMIN_PASSWORD = 'admin123';

/** 动作名 */
export const ACTION = {
  LOGIN: 'login',
} as const;

/** 示例应用端口 */
export const DINNER_PORT = 4321;
