import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ServerResponse } from 'http';
import { HTTP_HEADER } from '../constants';

/** MD5 摘要 */
export function md5(str: string): string {
  return crypto.createHash('md5').update(String(str)).digest('hex');
}

/** [min, max] 区间随机整数 */
export function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** 随机字符串 */
export function randString(size = 8): string {
  const chars =
    '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  while (size--) result += chars.charAt(rand(0, chars.length - 1));
  return result;
}

/** 解析 Cookie 请求头 */
export function parseCookie(header?: string): Record<string, string | undefined> {
  const cookies: Record<string, string | undefined> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    let value = pair.slice(idx + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* 保留原值 */
    }
    cookies[key] = value;
  }
  return cookies;
}

export interface CookieOptions {
  maxAge?: number;
  domain?: string;
  path?: string;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** 序列化单个 Set-Cookie 值 */
export function serializeCookie(
  name: string,
  value: string,
  option: CookieOptions = { path: '/' },
): string {
  const pairs = [`${name}=${encodeURIComponent(value)}`];
  if (option.maxAge !== undefined) pairs.push(`Max-Age=${option.maxAge}`);
  if (option.domain) pairs.push(`Domain=${option.domain}`);
  if (option.path) pairs.push(`Path=${option.path}`);
  if (option.expires) pairs.push(`Expires=${option.expires.toUTCString()}`);
  if (option.httpOnly) pairs.push('HttpOnly');
  if (option.secure) pairs.push('Secure');
  if (option.sameSite) pairs.push(`SameSite=${option.sameSite}`);
  return pairs.join('; ');
}

/** 追加一个 Set-Cookie 响应头（保留已有值） */
export function appendSetCookie(res: ServerResponse, cookie: string): void {
  const prev = res.getHeader(HTTP_HEADER.SET_COOKIE);
  const list = prev
    ? (Array.isArray(prev) ? prev.map(String) : [String(prev)]).concat(cookie)
    : [cookie];
  res.setHeader(HTTP_HEADER.SET_COOKIE, list);
}

/** 递归创建目录（同步） */
export function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

const DATE_PAD = (n: number, len = 2) => String(n).padStart(len, '0');

/** 格式化日期，如 yyyy-MM-dd hh:mm:ss */
export function formatDate(
  date?: Date | number,
  pattern = 'yyyy-MM-dd',
): string {
  const d = date === undefined ? new Date() : new Date(date);
  const map: Record<string, number> = {
    y: d.getFullYear(),
    M: d.getMonth() + 1,
    d: d.getDate(),
    h: d.getHours(),
    m: d.getMinutes(),
    s: d.getSeconds(),
  };
  return pattern.replace(/(y+|M+|d+|h+|m+|s+)/g, (raw, token: string) => {
    const value = map[token[0]];
    return token[0] === 'y'
      ? String(value).slice(-token.length)
      : DATE_PAD(value, token.length);
  });
}

/** yyyy-MM-dd hh:mm:ss */
export function formatDateTime(date?: Date | number): string {
  return formatDate(date ?? Date.now(), 'yyyy-MM-dd hh:mm:ss');
}

/** 去除 HTML 标签后截取摘要 */
export function getSummary(str: string, len = 100): string {
  const text = String(str)
    .replace(/<\/?[^>]*>/g, '')
    .replace(/[ | ]*\n/g, '\n')
    .replace(/&nbsp;/gi, '');
  return text.length > len ? text.slice(0, len) : text;
}

export function isPromise(v: unknown): v is Promise<unknown> {
  return !!(v && typeof (v as any).then === 'function');
}
