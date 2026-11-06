import { Injectable } from '../../../container/decorators';
import { formatDateTime } from '../../../utils';

/** 可注入服务：任何地方构造函数声明即可获得单例实例 */
@Injectable()
export class TimeService {
  /** 当前时间（yyyy-MM-dd hh:mm:ss） */
  now(): string {
    return formatDateTime(Date.now());
  }

  /** 进程运行时长（秒） */
  uptime(): number {
    return Math.floor(process.uptime());
  }
}
