import { MINUTE_MS } from '../../constants';

/** DI 令牌（registerValue / @Inject 共用） */
export const TOKEN = {
  RATE_LIMIT: 'RATE_LIMIT',
  BANNED_IPS: 'BANNED_IPS',
} as const;

/** 会话数据键 */
export const SESSION_KEY = {
  USER_ID: 'userId',
  USERNAME: 'username',
  IS_ADMIN: 'isAdmin',
} as const;

/** 数据表名（QueryBuilder 会自动加 ham_ 前缀） */
export const TABLE = {
  USERS: 'users',
  MESSAGES: 'messages',
} as const;

/** 分页 */
export const DEFAULT_PAGE_NO = 1;
export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 50;

/** 限流 */
export const DEFAULT_RATE_LIMIT = {
  max: 10,
  windowMs: MINUTE_MS,
};
export const RATE_LIMIT_BUCKET_LIMIT = 10_000;

/** 用户与密码规则 */
export const USERNAME_MIN_LENGTH = 2;
export const USERNAME_MAX_LENGTH = 20;
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 64;
export const SALT_BYTES = 16;
export const SCRYPT_KEY_LENGTH = 32;
export const ADMIN_FLAG = { YES: 1, NO: 0 } as const;

/** 默认昵称 */
export const ANONYMOUS_NICKNAME = '匿名';

/** 查询参数中的布尔标记值（如 ?posted=1） */
export const TRUE_FLAG = '1';

/** 示例应用端口 */
export const BOARD_PORT = 4320;
