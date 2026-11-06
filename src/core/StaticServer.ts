import * as fs from 'fs';
import * as path from 'path';
import { IncomingMessage, ServerResponse } from 'http';
import mime from 'mime';
import {
  CONTENT_TYPE,
  DEFAULT_HOST,
  HTTP_HEADER,
  HTTP_METHOD,
  HTTP_STATUS,
  SECOND_MS,
} from '../constants';
import { DEFAULT_CONFIG } from '../types';

/** 可作为静态资源输出的扩展名白名单 */
const EXT_RE =
  /\.(html?|gif|jpe?g|bmp|webp|htc|swf|png|ico|txt|js|mjs|css|svg|woff2?|ttf|eot)$/i;

/** Node 请求头统一为小写键 */
const IF_NONE_MATCH_HEADER = HTTP_HEADER.IF_NONE_MATCH.toLowerCase();
const IF_MODIFIED_SINCE_HEADER = HTTP_HEADER.IF_MODIFIED_SINCE.toLowerCase();

/**
 * 静态资源服务。
 * 相比 1.x 修复了路径穿越问题：所有路径先归一化并强制收敛到 static 根目录内。
 */
export class StaticServer {
  private readonly root: string;
  private readonly urlPrefix: string;
  private readonly maxAgeMs: number;

  constructor(
    appPath: string,
    staticDir: string,
    maxAgeMs = DEFAULT_CONFIG.staticMaxAge,
  ) {
    this.root = path.resolve(appPath, staticDir) + path.sep;
    // URL 前缀取静态目录名（默认 /static/）
    this.urlPrefix = '/' + path.basename(path.resolve(appPath, staticDir)) + '/';
    this.maxAgeMs = maxAgeMs;
  }

  /** 路径是否属于静态资源前缀（同步、无 IO） */
  handles(pathname: string): boolean {
    return pathname.startsWith(this.urlPrefix);
  }

  /**
   * 把相对路径解析为 static 根目录内的安全绝对路径。
   * 不在白名单、越界或文件不存在时返回 null。
   */
  resolve(relativePath: string): string | null {
    const target = this.resolvePath(relativePath);
    if (!target) return null;
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
    return target;
  }

  /** 纯路径校验（解码、白名单、穿越防护），不访问文件系统 */
  private resolvePath(relativePath: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(relativePath);
    } catch {
      return null;
    }
    if (!EXT_RE.test(decoded)) return null;
    // posix.normalize 会折叠 ".."，保证结果不逃出根目录；resolve + startsWith 双重保险
    const normalized = path.posix.normalize('/' + decoded.replace(/\\/g, '/'));
    const target = path.resolve(this.root, '.' + normalized);
    if (!target.startsWith(this.root) && target + path.sep !== this.root) {
      return null;
    }
    return target;
  }

  /** 尝试按静态资源响应；返回 false 表示交给 MVC 路由（同步版本，保留兼容） */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const pathname = new URL(req.url || '/', `http://${DEFAULT_HOST}`).pathname;
    if (!this.handles(pathname)) return false;
    const file = this.resolve(pathname.slice(this.urlPrefix.length - 1));
    if (!file) return false;

    res.setHeader(
      HTTP_HEADER.CONTENT_TYPE,
      mime.getType(file) || CONTENT_TYPE.OCTET_STREAM,
    );
    res.setHeader(
      HTTP_HEADER.CACHE_CONTROL,
      `public, max-age=${Math.floor(this.maxAgeMs / SECOND_MS)}`,
    );

    if (req.method === HTTP_METHOD.HEAD) {
      res.end();
      return true;
    }
    const stream = fs.createReadStream(file);
    stream.on('error', () => {
      if (!res.headersSent) res.statusCode = HTTP_STATUS.NOT_FOUND;
      res.end();
    });
    stream.pipe(res);
    return true;
  }

  /**
   * 异步静态资源处理（框架请求热路径使用）：
   * 带 Content-Length / ETag / Last-Modified，支持 If-None-Match / If-Modified-Since 返回 304。
   * 文件不存在或非文件时返回 false，交由 MVC 路由继续处理。
   */
  async handleAsync(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const pathname = url.pathname;
    if (!this.handles(pathname)) return false;
    const file = this.resolvePath(pathname.slice(this.urlPrefix.length - 1));
    if (!file) return false;

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;

    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const lastModified = stat.mtime.toUTCString();
    res.setHeader(
      HTTP_HEADER.CONTENT_TYPE,
      mime.getType(file) || CONTENT_TYPE.OCTET_STREAM,
    );
    res.setHeader(
      HTTP_HEADER.CACHE_CONTROL,
      `public, max-age=${Math.floor(this.maxAgeMs / SECOND_MS)}`,
    );
    res.setHeader(HTTP_HEADER.ETAG, etag);
    res.setHeader(HTTP_HEADER.LAST_MODIFIED, lastModified);

    if (this.isNotModified(req, etag, stat.mtimeMs)) {
      res.statusCode = HTTP_STATUS.NOT_MODIFIED;
      res.end();
      return true;
    }

    res.setHeader(HTTP_HEADER.CONTENT_LENGTH, stat.size);
    if (req.method === HTTP_METHOD.HEAD) {
      res.end();
      return true;
    }

    const stream = fs.createReadStream(file);
    stream.on('error', () => {
      if (!res.headersSent) res.statusCode = HTTP_STATUS.NOT_FOUND;
      res.end();
    });
    stream.pipe(res);
    return true;
  }

  private isNotModified(
    req: IncomingMessage,
    etag: string,
    mtimeMs: number,
  ): boolean {
    const rawIfNoneMatch = req.headers[IF_NONE_MATCH_HEADER];
    const ifNoneMatch = Array.isArray(rawIfNoneMatch)
      ? rawIfNoneMatch.join(',')
      : rawIfNoneMatch;
    if (ifNoneMatch) {
      return ifNoneMatch
        .split(',')
        .map((value) => value.trim())
        .some((value) => value === '*' || value === etag);
    }
    const rawIfModifiedSince = req.headers[IF_MODIFIED_SINCE_HEADER];
    const ifModifiedSince = Array.isArray(rawIfModifiedSince)
      ? rawIfModifiedSince[0]
      : rawIfModifiedSince;
    if (ifModifiedSince) {
      const since = Date.parse(ifModifiedSince);
      if (!Number.isNaN(since)) {
        // HTTP 日期精度为秒
        return Math.floor(mtimeMs / SECOND_MS) <= Math.floor(since / SECOND_MS);
      }
    }
    return false;
  }
}
