/** 常用 HTTP 状态码（替代散落的魔法数字） */
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  MOVED_PERMANENTLY: 301,
  FOUND: 302,
  NOT_MODIFIED: 304,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  REQUEST_TIMEOUT: 408,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
} as const;

export type HttpStatus = (typeof HTTP_STATUS)[keyof typeof HTTP_STATUS];

/** 框架内使用的 Content-Type 常量 */
export const CONTENT_TYPE = {
  TEXT: 'text/plain; charset=utf-8',
  HTML: 'text/html; charset=utf-8',
  JSON: 'application/json; charset=utf-8',
  OCTET_STREAM: 'application/octet-stream',
} as const;

/** 常用 MIME 类型（用于请求体类型判断） */
export const MIME_TYPE = {
  JSON: 'application/json',
  MULTIPART: 'multipart/form-data',
  FORM_URLENCODED: 'application/x-www-form-urlencoded',
} as const;

/** 常用 HTTP 方法 */
export const HTTP_METHOD = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DELETE',
  HEAD: 'HEAD',
  OPTIONS: 'OPTIONS',
} as const;

/** 框架内使用的 HTTP 响应头名称 */
export const HTTP_HEADER = {
  CONTENT_TYPE: 'Content-Type',
  CONTENT_LENGTH: 'Content-Length',
  CACHE_CONTROL: 'Cache-Control',
  ETAG: 'ETag',
  LAST_MODIFIED: 'Last-Modified',
  LOCATION: 'Location',
  SET_COOKIE: 'Set-Cookie',
  USE_TIME: 'Use-Time',
  REQUEST_ID: 'X-Request-Id',
  IF_NONE_MATCH: 'If-None-Match',
  IF_MODIFIED_SINCE: 'If-Modified-Since',
} as const;

/** 时间单位（毫秒） */
export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;

/** 路由缺省控制器 / 动作 */
export const DEFAULT_CONTROLLER = 'index';
export const DEFAULT_ACTION = 'index';

/** 解析相对 URL 时使用的缺省主机名 */
export const DEFAULT_HOST = 'localhost';
