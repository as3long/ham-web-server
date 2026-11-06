import * as fs from 'fs';
import * as path from 'path';
import { IncomingMessage } from 'http';
import formidable from 'formidable';
import { filterXSS } from 'xss';
import { HamConfig, PostData, UploadedFile } from '../types';
import { mkdirp } from '../utils';
import { HTTP_HEADER, HTTP_METHOD, MIME_TYPE } from '../constants';

/** Node 请求头统一为小写键 */
const CONTENT_TYPE_HEADER = HTTP_HEADER.CONTENT_TYPE.toLowerCase();
const MAX_FORM_FIELDS_SIZE = 5 * 1024 * 1024;

/** 读取原始请求体（带大小上限） */
async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) {
      throw new Error(`[ham] 请求体超过上限 ${max} 字节`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

const sanitize = (v: string, enabled: boolean) => (enabled ? filterXSS(v) : v);

/**
 * 解析 POST/PUT/PATCH 请求体。
 * - application/json -> JSON.parse（字符串字段同样做 XSS 过滤关闭时可配置）
 * - 表单 / multipart -> formidable（上传文件落到 tempDir）
 * 字段值统一归一化为 string。
 */
export async function parseBody(
  req: IncomingMessage,
  config: HamConfig,
  appPath: string,
): Promise<PostData> {
  const empty: PostData = { fields: {}, files: {} };
  const method = (req.method || HTTP_METHOD.GET).toUpperCase();
  if (
    method !== HTTP_METHOD.POST &&
    method !== HTTP_METHOD.PUT &&
    method !== HTTP_METHOD.PATCH
  ) {
    return empty;
  }
  const contentType = String(req.headers[CONTENT_TYPE_HEADER] || '');

  if (contentType.includes(MIME_TYPE.JSON)) {
    const raw = await readRaw(req, config.maxBodySize);
    let parsed: any = {};
    try {
      parsed = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      parsed = {};
    }
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed ?? {})) {
      if (v === null || v === undefined) continue;
      fields[k] = sanitize(typeof v === 'string' ? v : JSON.stringify(v), false);
    }
    return { fields, files: {} };
  }

  const uploadDir = path.resolve(appPath, config.tempDir);
  mkdirp(uploadDir);
  const form = formidable({
    encoding: 'utf-8',
    uploadDir,
    keepExtensions: true,
    maxFileSize: config.maxBodySize,
    maxFieldsSize: Math.min(config.maxBodySize, MAX_FORM_FIELDS_SIZE),
  });
  const [fields, files] = await new Promise<any>((resolve, reject) => {
    form.parse(req, (err: any, f: any, fl: any) =>
      err ? reject(err) : resolve([f, fl]),
    );
  });

  const normFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    const value = Array.isArray(v) ? v[0] : v;
    normFields[k] = sanitize(String(value ?? ''), config.enableXss);
  }

  const normFiles: Record<string, UploadedFile> = {};
  for (const [k, v] of Object.entries(files ?? {})) {
    const f: any = Array.isArray(v) ? v[0] : v;
    if (!f) continue;
    normFiles[k] = {
      tmpPath: f.filepath ?? f.path ?? '',
      originalName: f.originalFilename ?? f.name ?? '',
      size: Number(f.size || 0),
      type: f.mimetype ?? f.type ?? '',
    };
  }
  return { fields: normFields, files: normFiles };
}
