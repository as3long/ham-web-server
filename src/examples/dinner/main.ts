import 'reflect-metadata';
import * as path from 'path';
import { HamApplication } from '../..';
import {
  runExample,
  exampleSessionStore,
  exampleLogRequests,
} from '../shared/runtime';
import { MenuService } from './services/MenuService';
import { OrderService } from './services/OrderService';
import { MenuController } from './controllers/MenuController';
import { AdminController } from './controllers/AdminController';
import {
  DEFAULT_ADMIN_PASSWORD,
  DINNER_PORT,
  SLOW_REQUEST_MS,
  TOKEN,
} from './constants';

async function bootstrap(): Promise<void> {
  const app = new HamApplication({
    appPath: __dirname,
    config: {
      dbType: 'sqlite',
      sqlitePath: path.resolve(__dirname, '../../../data/dinner.sqlite'),
      port: DINNER_PORT,
      sessionStore: exampleSessionStore(),
      logRequests: exampleLogRequests(),
    },
  });
  const logger = app.logger;

  // ---- IoC 注册 ------------------------------------------------------
  app.register(MenuService);
  app.register(OrderService);
  // 店主登录口令（可用环境变量覆盖）
  app.registerValue(
    TOKEN.ADMIN_PASSWORD,
    process.env.DINNER_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD,
  );

  // ---- 全局拦截器 -----------------------------------------------------
  const slowLogger = logger.child({ module: 'dinner' });
  app.addInterceptor(async (ctx, next) => {  // 函数式：慢请求日志（>200ms 才打印）
    await next();
    if (ctx.useTime > SLOW_REQUEST_MS) {
      slowLogger.warn(
        {
          requestId: ctx.requestId,
          method: ctx.method,
          path: ctx.url.pathname,
          durationMs: ctx.useTime,
        },
        '慢请求',
      );
    }
  });

  // ---- 控制器 ---------------------------------------------------------
  // AdminController 类上有 @UseGuards(AdminLoginGuard)，声明即生效
  app.addController(MenuController);
  app.addController(AdminController);

  // ---- 数据初始化（建表 + 种子菜品） -----------------------------------
  await app.container.resolve(MenuService).ensureTable();
  await app.container.resolve(OrderService).ensureTable();
  await app.container.resolve(MenuService).seedIfEmpty();

  app.enableShutdownHooks();

  const server = await app.listen();
  const port = typeof server.address() === 'object' && server.address()
    ? (server.address() as any).port
    : DINNER_PORT;
  logger.info({ port }, `点餐系统已启动: http://localhost:${port}/dinner/`);
  logger.info('店主后台: /dinner-admin/ （口令 admin123，可用 DINNER_ADMIN_PASSWORD 覆盖）');
}

runExample(bootstrap).catch((err) => {
  console.error(err);
  process.exit(1);
});
