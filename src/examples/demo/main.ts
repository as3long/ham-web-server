import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { HamApplication, Database } from '../..';
import {
  runExample,
  exampleSessionStore,
  exampleLogRequests,
} from '../shared/runtime';
import { IndexController } from './controllers/IndexController';
import { UserController } from './controllers/UserController';
import { UserService } from './services/UserService';
import { TimeService } from './services/TimeService';
import { DEMO_PORT, DEMO_VERSION, TABLE, TOKEN } from './constants';

async function bootstrap(): Promise<void> {
  const app = new HamApplication({
    appPath: __dirname,
    config: {
      debug: true,
      dbType: 'sqlite',
      sqlitePath: path.resolve(__dirname, '../../../data/demo.sqlite'),
      sessionStore: exampleSessionStore(),
      logRequests: exampleLogRequests(),
    },
  });
  const logger = app.logger;

  // ---- IoC 注册 ------------------------------------------------------
  app.register(TimeService); // 单例服务
  app.register(UserService); // 内部注入了 Database
  app.registerValue(TOKEN.APP_VERSION, DEMO_VERSION); // 字符串令牌，配合 @Inject

  app.addController(IndexController);
  app.addController(UserController);

  // ---- 初始化数据库 ---------------------------------------------------
  const db = app.container.resolve(Database);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE.USERS_FULL} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL DEFAULT 0
    )
  `);

  app.enableShutdownHooks();

  const server = await app.listen();
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : DEMO_PORT;
  logger.info({ port }, `ham-web-server 已启动: http://localhost:${port}`);
  logger.info('页面: /  |  /user  |  /user/add  |  /user/api/1  |  /index/time');
}

runExample(bootstrap).catch((err) => {
  console.error(err);
  process.exit(1);
});
