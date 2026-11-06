/** DI 令牌 */
export const TOKEN = {
  APP_VERSION: 'APP_VERSION',
} as const;

/** 数据表名（QueryBuilder 会自动加 ham_ 前缀） */
export const TABLE = {
  /** QueryBuilder 使用的逻辑表名（自动加 ham_ 前缀） */
  USERS: 'users',
  /** 原生 DDL 使用的完整表名 */
  USERS_FULL: 'ham_users',
} as const;

/** 示例应用 */
export const DEMO_VERSION = '2.0.0';
export const DEMO_PORT = 3000;
export const USER_LIST_LIMIT = 50;
export const DEFAULT_USER_LIST_LIMIT = 20;
