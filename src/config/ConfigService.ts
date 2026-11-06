import { Injectable } from '../container/decorators';
import { DEFAULT_CONFIG, HamConfig } from '../types';

/**
 * 配置服务：默认配置 + 应用配置的合并结果。可注入到任何服务/控制器。
 */
@Injectable()
export class ConfigService {
  readonly config: Readonly<HamConfig>;

  constructor(userConfig: Partial<HamConfig> = {}) {
    this.config = Object.freeze({ ...DEFAULT_CONFIG, ...userConfig });
  }

  get<K extends keyof HamConfig>(key: K): HamConfig[K] {
    return this.config[key];
  }
}
