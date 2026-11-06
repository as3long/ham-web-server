import 'reflect-metadata';
import * as path from 'path';
import { HamApplication } from '../..';
import {
  runExample,
  exampleSessionStore,
  exampleLogRequests,
} from '../shared/runtime';
import { MessageService } from './services/MessageService';
import { UserService } from './services/UserService';
import { MessageBoardController } from './controllers/MessageBoardController';
import { IndexController } from './controllers/IndexController';
import { RateLimitOptions } from './interceptors/RateLimitInterceptor';
import { BOARD_PORT, DEFAULT_RATE_LIMIT, TOKEN } from './constants';

async function bootstrap(): Promise<void> {
  const app = new HamApplication({
    appPath: __dirname,
    config: {
      dbType: 'sqlite',
      sqlitePath:
        process.env.BOARD_DB ||
        path.resolve(__dirname, '../../../data/message-board.sqlite'),
      port: BOARD_PORT,
      sessionStore: exampleSessionStore(),
      logRequests: exampleLogRequests(),
    },
  });
  const logger = app.logger;

  // ---- IoC 注册 ------------------------------------------------------
  app.register(MessageService);
  app.register(UserService);
  app.registerValue<RateLimitOptions>(TOKEN.RATE_LIMIT, DEFAULT_RATE_LIMIT);
  // 拉黑 IP 名单（逗号分隔，演示用；默认为空）
  app.registerValue<string[]>(
    TOKEN.BANNED_IPS,
    (process.env.BANNED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  // 全局守卫（函数式）：拦下查询参数中的脚本注入尝试（返回 false -> 默认 403）
  // （ab 对比时临时禁用：HAM_NO_GLOBAL_GUARD=1 跳过）
  if (process.env.HAM_NO_GLOBAL_GUARD !== '1') {
    app.addGuard(async (ctx) => {
      const evil = /<script|<iframe/i;
      return !Object.values(ctx.query).some((v) => evil.test(v));
    });
  }
  // AdminTokenGuard / BannedIpGuard 由 @UseGuards 声明即用，无需手工注册
  app.addController(IndexController);
  app.addController(MessageBoardController);

  // ---- 数据库初始化 ---------------------------------------------------
  await app.container.resolve(MessageService).ensureTable(); // 建表 + 旧库迁移
  await app.container.resolve(UserService).ensureTable();
  await app.container.resolve(MessageService).seedIfEmpty();

  app.enableShutdownHooks();

  const server = await app.listen();
  const port = typeof server.address() === 'object' && server.address()
    ? (server.address() as any).port
    : BOARD_PORT;
  logger.info({ port }, `已启动: http://localhost:${port}/board/`);
  logger.info('JSON 接口: /board/api | 提交: /board/apiAdd');
}

runExample(bootstrap).catch((err) => {
  console.error(err);
  process.exit(1);
});
