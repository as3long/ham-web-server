import * as path from 'path';
import * as fs from 'fs';
import template from 'art-template';
import { Injectable } from '../container/decorators';
import { ConfigService } from '../config/ConfigService';
import { formatDate, formatDateTime, getSummary, md5 } from '../utils';

/**
 * 视图引擎：art-template 封装（与 1.x 的 display() 对应）。
 * 模板目录为 appPath/views，默认扩展名 .html。
 */
@Injectable()
export class ViewEngine {
  private readonly viewRoot: string;
  private readonly viewExt: string;

  constructor(config: ConfigService, appPath: string) {
    const cfg = config.config;
    this.viewRoot = path.resolve(appPath, cfg.viewDir) + path.sep;
    this.viewExt = cfg.viewExt.startsWith('.') ? cfg.viewExt : '.' + cfg.viewExt;
    template.defaults.root = this.viewRoot;
    template.defaults.extname = this.viewExt;
    template.defaults.cache = !cfg.debug;
    template.defaults.debug = cfg.debug;
    // 模板内可直接使用的工具函数：{{$imports.formatDateTime(createdAt)}}
    template.defaults.imports.formatDateTime = formatDateTime;
    template.defaults.imports.formatDate = formatDate;
    template.defaults.imports.getSummary = getSummary;
    template.defaults.imports.md5 = md5;
  }

  /**
   * 渲染模板。tplPath 支持子目录（如 'user/list'），缺省扩展名自动补全。
   */
  render(tplPath: string, data: Record<string, unknown> = {}): string {
    const relative = tplPath.replace(/\.(html?|art)$/i, '');
    const file = path.resolve(this.viewRoot, relative + this.viewExt);
    if (!file.startsWith(this.viewRoot)) {
      throw new Error(`[ham-view] 模板路径越界: ${tplPath}`);
    }
    if (!fs.existsSync(file)) {
      throw new Error(`[ham-view] 模板不存在: ${file}`);
    }
    return template(file, data) as unknown as string;
  }
}
