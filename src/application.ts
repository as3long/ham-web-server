import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { Container } from './container/Container';
import { collectGuards, collectInterceptors } from './container/decorators';
import { ConfigService } from './config/ConfigService';
import { loadEnv, readEnvConfig } from './config/env';
import {
  CONTENT_TYPE,
  DEFAULT_HOST,
  HTTP_HEADER,
  HTTP_METHOD,
  HTTP_STATUS,
} from './constants';
import { Context } from './core/Context';
import { parseRoute, Router } from './core/Router';
import { StaticServer } from './core/StaticServer';
import { createLazySession, SessionService } from './core/SessionService';
import { compose, Interceptor, InterceptorLike, toInterceptor } from './core/interceptor';
import { canAllActivate, Guard, GuardLike, toGuard } from './core/guard';
import { ViewEngine } from './view/ViewEngine';
import { Database } from './database/Database';
import { HamConfig, Type } from './types';
import { isManagedProcess } from './cluster';
import { Logger, LoggerLike } from './logging/Logger';

export interface AppOptions {
  /** 应用根目录（视图/静态/临时目录的基准） */
  appPath: string;
  /** 应用配置（覆盖默认值与环境变量） */
  config?: Partial<HamConfig>;
  /**
   * 启动时加载的 .env 文件：相对路径基于 appPath；`false` 关闭自动加载。
   * 缺省依次尝试 `cwd/.env`、`appPath/.env`。
   */
  envFile?: string | false;
  /** 自定义日志器；缺省使用内置 pino Logger */
  logger?: LoggerLike;
}

/**
 * Ham 应用：组装 IoC 容器、路由、会话、静态资源，并启动 HTTP 服务。
 *
 * ```ts
 * const app = new HamApplication({ appPath: __dirname, config: { port: 3000 } });
 * app.register(UserService);            // 注册 @Injectable 服务
 * app.registerValue('APP_VERSION', '2.0.0');
 * app.addController(IndexController);   // 注册 @Controller 控制器
 * await app.listen();
 * ```
 */
export class HamApplication {
  readonly container = new Container();
  readonly router = new Router();
  server?: http.Server;
  private readonly appPath: string;
  private readonly globalInterceptors: InterceptorLike[] = [];
  private readonly globalGuards: GuardLike[] = [];

  // listen() 时预解析的请求热路径服务
  private configService!: ConfigService;
  private staticServer!: StaticServer;
  private sessionService!: SessionService;
  private loggerService?: LoggerLike;

  /** 优雅关闭状态 */
  private shuttingDown = false;
  private closePromise?: Promise<void>;
  private shutdownListeners: (() => void)[] = [];
  private shutdownHooksEnabled = false;
  private loggerClosed = false;

  /** 请求级执行计划缓存：路由版本变化时整体重建 */
  private planVersion = 0;
  private cachedPlanVersion = -1;
  private readonly plans = new Map<string, RoutePlan>();

  constructor(options: AppOptions) {
    this.appPath = path.resolve(options.appPath);
    // 先加载 .env（真实环境变量优先），再把 HAM_* 映射进配置；显式 config 优先级最高
    loadEnv(this.appPath, options.envFile);
    this.registerDefaults(
      { ...readEnvConfig(), ...(options.config ?? {}) },
      options.logger,
    );
  }

  // ------------------------------------------------------------- 日志

  /** 当前应用日志器（单例） */
  get logger(): LoggerLike {
    return this.container.resolve(Logger);
  }

  /**
   * 替换日志器，必须在 listen() 或首次访问 logger 之前调用。
   * 适用于接入 winston/consola 或测试用的捕获式日志器。
   */
  setLogger(logger: LoggerLike): this {
    if (this.server) {
      throw new Error('[ham-log] setLogger() 必须在 listen() 之前调用');
    }
    if (typeof logger?.child !== 'function') {
      throw new Error('[ham-log] 自定义 logger 必须实现 child(bindings)');
    }
    this.container.registerValue(Logger, logger);
    this.loggerService = logger;
    return this;
  }

  // ------------------------------------------------------------- 注册

  /** 框架内置服务的注册（仅内部使用） */
  private registerDefaults(
    userConfig: Partial<HamConfig>,
    logger?: LoggerLike,
  ): void {
    this.container.registerFactory(
      ConfigService,
      () => new ConfigService(userConfig),
    );
    if (logger) {
      if (typeof logger.child !== 'function') {
        throw new Error('[ham-log] 自定义 logger 必须实现 child(bindings)');
      }
      this.container.registerValue(Logger, logger);
    } else {
      this.container.registerFactory(
        Logger,
        (c) => new Logger(c.resolve(ConfigService), this.appPath),
      );
    }
    this.container.registerFactory(
      Database,
      (c) => new Database(c.resolve(ConfigService), this.appPath),
    );
    this.container.registerFactory(
      ViewEngine,
      (c) => new ViewEngine(c.resolve(ConfigService), this.appPath),
    );
    this.container.registerFactory(
      StaticServer,
      (c) =>
        new StaticServer(
          this.appPath,
          c.resolve(ConfigService).get('staticDir'),
        ),
    );
    this.container.registerClass(SessionService);
  }

  /** 注册 @Injectable 服务类 */
  register<T>(type: Type<T>): this {
    this.container.registerClass(type);
    return this;
  }

  /** 注册常量值（配合 @Inject('TOKEN') 使用） */
  registerValue<T>(token: string | symbol, value: T): this {
    this.container.registerValue(token, value);
    return this;
  }

  /** 注册工厂 */
  registerFactory<T>(
    token: any,
    factory: (c: Container) => T,
    scope: 'singleton' | 'transient' | 'request' = 'singleton',
  ): this {
    this.container.registerFactory(token, factory, scope);
    return this;
  }

  /** 注册 @Controller 控制器（每次请求创建新实例） */
  addController(ctor: Type<any>): this {
    this.router.add(ctor);
    this.container.register(
      ctor,
      { useClass: ctor },
      'transient',
      { requireInjectable: false },
    );
    this.planVersion++;
    return this;
  }

  /**
   * 注册全局拦截器（对除静态资源外的所有 MVC 请求生效）。
   * - 传类：需标注 @Injectable()，经 IoC 容器解析（可在构造函数中注入服务）
   * - 传函数：(ctx, next) => Promise 形式
   *
   * 执行顺序：全局 -> 控制器级（@UseInterceptors 在类上）-> 动作级（在方法上）。
   */
  addInterceptor(interceptor: InterceptorLike): this {
    if (
      typeof interceptor === 'function' &&
      typeof (interceptor as Type<Interceptor>).prototype?.intercept === 'function'
    ) {
      this.container.registerClass(interceptor as Type<Interceptor>);
    }
    this.globalInterceptors.push(interceptor);
    this.planVersion++;
    return this;
  }

  /**
   * 确保类形态的拦截器已注册到容器。
   *
   * @UseInterceptors 元数据中引用的拦截器类不会经过 addInterceptor()，
   * 这里在组装链时按需自动注册（幂等），使“声明即用”成为可能。
   */
  private ensureInterceptorRegistered(like: InterceptorLike): void {
    if (
      typeof like === 'function' &&
      typeof (like as Type<Interceptor>).prototype?.intercept === 'function' &&
      !this.container.has(like as Type<Interceptor>)
    ) {
      this.container.registerClass(like as Type<Interceptor>);
    }
  }

  /**
   * 注册全局守卫（对除静态资源外的所有 MVC 请求生效）。
   * - 传类：需标注 @Injectable()，经 IoC 容器解析（可在构造函数中注入服务）
   * - 传函数：(ctx) => boolean | Promise<boolean> 形式
   *
   * 执行顺序：全局 -> 控制器级（@UseGuards 在类上）-> 动作级（在方法上），
   * 任一拒绝即短路；守卫先于拦截器与请求体解析执行。
   */
  addGuard(guard: GuardLike): this {
    if (
      typeof guard === 'function' &&
      typeof (guard as Type<Guard>).prototype?.canActivate === 'function'
    ) {
      this.container.registerClass(guard as Type<Guard>);
    }
    this.globalGuards.push(guard);
    this.planVersion++;
    return this;
  }

  /**
   * 确保类形态的守卫已注册到容器。
   *
   * @UseGuards 元数据中引用的守卫类不会经过 addGuard()，
   * 这里在组装链时按需自动注册（幂等），与拦截器行为保持一致。
   */
  private ensureGuardRegistered(like: GuardLike): void {
    if (
      typeof like === 'function' &&
      typeof (like as Type<Guard>).prototype?.canActivate === 'function' &&
      !this.container.has(like as Type<Guard>)
    ) {
      this.container.registerClass(like as Type<Guard>);
    }
  }

  // ------------------------------------------------------------- 启动/停止

  /** 启动 HTTP 服务。端口优先级：参数 > 环境变量 PORT > 配置 > 3000 */
  async listen(port?: number): Promise<http.Server> {
    if (this.server) return this.server;

    // 预解析核心服务，尽早暴露配置错误；请求热路径直接复用这些实例
    this.configService = this.container.resolve(ConfigService);
    this.loggerService = this.container.resolve(Logger);
    this.sessionService = this.container.resolve(SessionService);
    this.staticServer = this.container.resolve(StaticServer);
    this.container.resolve(ViewEngine);

    // 初始化会话存储（数据库存储会建表；失败时拒绝启动，交给 PM2 重启）
    try {
      await this.sessionService.init();
    } catch (err) {
      this.loggerService.error({ err }, '会话存储初始化失败');
      throw err;
    }

    if (this.isMultiProcessRuntime() && this.configService.get('sessionStore') === 'memory') {
      this.loggerService.warn(
        '检测到多进程环境，但 sessionStore=memory，会话不会跨 worker 共享；' +
          '请设置 sessionStore="database"（或 HAM_SESSION_STORE=database）。',
      );
    }

    const actualPort =
      port ?? (Number(process.env.PORT) || this.configService.get('port'));

    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.keepAliveTimeout = this.configService.get('keepAliveTimeout');
    this.server.headersTimeout = this.configService.get('headersTimeout');
    this.server.requestTimeout = this.configService.get('requestTimeout');
    // 畸形请求直接返回 400，避免默认行为直接断开连接
    this.server.on('clientError', (_err, socket) => {
      if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      }
    });

    try {
      await new Promise<net.AddressInfo | string>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        this.server!.once('error', onError);
        this.server!.listen(actualPort, () => {
          this.server!.removeListener('error', onError);
          resolve(this.server!.address() as net.AddressInfo | string);
        });
      });
    } catch (err) {
      this.loggerService.error({ err, port: actualPort }, 'HTTP 监听失败');
      throw err;
    }

    const address = this.server.address();
    const boundPort =
      typeof address === 'object' && address ? address.port : actualPort;
    this.loggerService.info(
      {
        port: boundPort,
        sessionStore: this.configService.get('sessionStore'),
        logLevel: this.configService.get('logLevel'),
        logRequests: this.configService.get('logRequests'),
      },
      'HTTP 服务已启动',
    );

    if (isManagedProcess()) {
      this.notifyReady();
    }

    this.enableShutdownHooks();
    return this.server;
  }

  /** PM2 就绪信号：worker 已监听并可接收请求 */
  private notifyReady(): void {
    try {
      if (typeof process.send === 'function') {
        process.send('ready');
      }
    } catch {
      // IPC 通道已关闭，不影响启动
    }
  }

  /** 是否运行在多进程环境（PM2 cluster / Node cluster / WORKERS>1） */
  private isMultiProcessRuntime(): boolean {
    if (isManagedProcess()) return true;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cluster = require('cluster');
    if (cluster.isWorker) return true;
    try {
      return Number(process.env.WORKERS ?? process.env.WEB_CONCURRENCY ?? 0) > 1;
    } catch {
      return false;
    }
  }

  /** 启用优雅关闭钩子（PM2/cluster worker 自动启用；单进程可显式调用） */
  enableShutdownHooks(options?: {
    signals?: NodeJS.Signals[];
    timeout?: number;
  }): this {
    if (this.shutdownHooksEnabled) return this;
    this.shutdownHooksEnabled = true;

    const configService =
      this.configService ?? this.container.resolve(ConfigService);
    const logger = this.loggerService ?? this.container.resolve(Logger);
    const signals = options?.signals ?? ['SIGINT', 'SIGTERM'];
    const timeout = options?.timeout ?? configService.get('shutdownTimeout');

    const onSignal = (signal: NodeJS.Signals) => {
      logger.info({ signal }, '收到退出信号，开始优雅关闭');
      void this.gracefulShutdown(timeout);
    };
    for (const sig of signals) {
      const handler = () => onSignal(sig);
      process.on(sig, handler);
      this.shutdownListeners.push(() => process.off(sig, handler));
    }

    const onFatal = (err: unknown) => {
      logger.error({ err }, '致命错误，开始优雅退出');
      void this.gracefulShutdown(timeout).then(() => process.exit(1));
    };
    if (process.listenerCount('uncaughtException') === 0) {
      process.on('uncaughtException', onFatal);
      this.shutdownListeners.push(() =>
        process.off('uncaughtException', onFatal),
      );
    }
    if (process.listenerCount('unhandledRejection') === 0) {
      process.on('unhandledRejection', onFatal);
      this.shutdownListeners.push(() =>
        process.off('unhandledRejection', onFatal),
      );
    }
    return this;
  }

  /** 优雅关闭：停止接收新连接 -> 等待在途请求 -> 关闭会话/数据库 */
  private async gracefulShutdown(timeout: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    const logger =
      this.loggerService ??
      (this.container.has(Logger) ? this.container.resolve(Logger) : undefined);
    const stopAt = Date.now() + timeout;

    // 1. 停止接受新连接
    if (this.server) {
      this.server.close(() => {});
      try {
        // Node >= 18.2：主动关闭空闲 keep-alive 连接
        if (typeof this.server.closeIdleConnections === 'function') {
          this.server.closeIdleConnections();
        }
      } catch {
        /* 忽略 */
      }
    }

    // 2. 等待在途请求完成，超时后强制关闭所有连接
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      const remaining = stopAt - Date.now();
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      try {
        if (typeof this.server.closeAllConnections === 'function') {
          this.server.closeAllConnections();
        }
      } catch {
        /* 忽略 */
      }
    }

    // 3. 等待未完成的会话写入，再关闭数据库
    try {
      await this.sessionService.close();
    } catch {
      /* 会话关闭失败不阻塞数据库关闭 */
    }
    try {
      if (this.container.has(Database)) {
        await this.container.resolve(Database).close();
      }
    } catch {
      /* 数据库关闭失败不阻塞退出 */
    }

    this.server = undefined;
    this.cleanupShutdownListeners();
    logger?.info('优雅关闭完成');
    await this.closeLogger();
  }

  /** 关闭服务与数据库连接（供测试与优雅退出使用） */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.shuttingDown = true;
      const logger =
        this.loggerService ??
        (this.container.has(Logger) ? this.container.resolve(Logger) : undefined);

      if (this.server) {
        await new Promise<void>((resolve) => {
          this.server!.close(() => resolve());
        });
        try {
          if (typeof this.server.closeIdleConnections === 'function') {
            this.server.closeIdleConnections();
          }
        } catch {
          /* 忽略 */
        }
        this.server = undefined;
      }
      try {
        await this.sessionService?.close();
      } catch {
        /* 忽略 */
      }
      try {
        if (this.container.has(Database)) {
          await this.container.resolve(Database).close();
        }
      } catch {
        /* 忽略 */
      }
      this.cleanupShutdownListeners();
      logger?.info('应用已关闭');
      await this.closeLogger();
    })();
    return this.closePromise;
  }

  private async closeLogger(): Promise<void> {
    if (this.loggerClosed) return;
    this.loggerClosed = true;
    const logger =
      this.loggerService ??
      (this.container.has(Logger) ? this.container.resolve(Logger) : undefined);
    try {
      await logger?.close?.();
    } catch {
      /* 忽略日志关闭失败 */
    }
  }

  private cleanupShutdownListeners(): void {
    for (const remove of this.shutdownListeners) remove();
    this.shutdownListeners = [];
    this.shutdownHooksEnabled = false;
  }

  // ------------------------------------------------------------- 请求处理

  /** 获取（或首次构建）路由执行计划；注册变化时整体重建 */
  private getRoutePlan(controllerName: string, actionName: string): RoutePlan {
    if (this.cachedPlanVersion !== this.planVersion) {
      this.plans.clear();
      this.cachedPlanVersion = this.planVersion;
    }
    const key = `${controllerName.toLowerCase()}/${actionName}`;
    let plan = this.plans.get(key);
    if (!plan) {
      plan = this.buildRoutePlan(controllerName, actionName);
      this.plans.set(key, plan);
    }
    return plan;
  }

  /**
   * 构建路由计划：控制器类 + 全局/控制器/动作级守卫与拦截器（只存 Like，不存实例）。
   * 实例仍按请求经 toGuard/toInterceptor 解析，request 作用域语义不变。
   */
  private buildRoutePlan(controllerName: string, actionName: string): RoutePlan {
    const ctor = this.router.find(controllerName);
    const guardLikes: GuardLike[] = [...this.globalGuards];
    const interceptorLikes: InterceptorLike[] = [...this.globalInterceptors];
    if (ctor) {
      guardLikes.push(...collectGuards(ctor, actionName));
      interceptorLikes.push(...collectInterceptors(ctor, actionName));
    }
    // 类形态的守卫/拦截器在此自动注册一次（幂等）
    for (const guard of guardLikes) this.ensureGuardRegistered(guard);
    for (const item of interceptorLikes) this.ensureInterceptorRegistered(item);
    return { ctor, guardLikes, interceptorLikes };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const debug = this.configService.get('debug');
    const logger = this.loggerService ?? this.container.resolve(Logger);
    const started = Date.now();
    let requestId = '';
    let requestLog: LoggerLike | undefined;

    try {
      // 1. 只解析一次 URL（静态资源与路由共用）
      const url = new URL(
        req.url || '/',
        `http://${req.headers.host || DEFAULT_HOST}`,
      );
      // 请求追踪 ID：优先透传客户端合法值，否则生成 UUID；静态资源也带该响应头
      requestId = ensureRequestId(req, res);

      // 2. 静态资源：先做无 IO 的前缀判断，命中后再走异步 stat + 条件请求
      if (
        this.staticServer.handles(url.pathname) &&
        (await this.staticServer.handleAsync(req, res, url))
      ) {
        return;
      }

      // 3. 路由解析
      const route = parseRoute(url.pathname);
      const routeLabel = `${route.controller}/${route.action}`;

      // 4. 访问日志（仅 MVC 请求；静态资源不记录）
      if (this.configService.get('logRequests')) {
        requestLog = logger.child({
          requestId,
          method: req.method,
          path: url.pathname,
          ip: req.socket.remoteAddress,
        });
        attachAccessLog(requestLog, res, routeLabel, started);
      }

      logger.debug(
        { requestId, method: req.method, path: url.pathname, route: routeLabel },
        '路由匹配',
      );

      // 5. 请求级容器：恢复会话（多进程下从数据库读取），再注册 Context
      const restored = await this.sessionService.restore(req, res);
      const requestContainer = this.container.createRequestContainer();
      const session =
        restored ??
        createLazySession(() => this.sessionService.start(req, res));
      const ctx = new Context(
        req,
        res,
        this.configService.config as HamConfig,
        url,
        session,
        this.appPath,
        requestId,
      );
      requestContainer.registerValue(Context, ctx);
      ctx.controller = route.controller;
      ctx.action = route.action;

      // 6. 守卫：全局 -> 控制器级 -> 动作级，全部通过才放行。
      //    守卫先于拦截器与请求体解析执行（鉴权判定最前置，拦截器短路无法绕过守卫）。
      const plan = this.getRoutePlan(route.controller, route.action);
      const ctor = plan.ctor;
      const guards: Guard[] = plan.guardLikes.map((g) =>
        toGuard(g, requestContainer),
      );
      if (guards.length > 0 && !(await canAllActivate(guards, ctx))) {
        logger.debug(
          { requestId, method: req.method, path: url.pathname, route: routeLabel },
          '守卫拒绝',
        );
        // 守卫通常已自行响应（ctx.echo/ctx.redirect）；未响应时兜底默认 403
        return forbidden(res, route.controller, route.action);
      }

      // 7. 组装拦截器链：全局 -> 控制器级 -> 动作级（洋葱模型，越靠内越贴近动作）
      const chain: Interceptor[] = plan.interceptorLikes.map((item) =>
        toInterceptor(item, requestContainer),
      );

      // 8. 最内层处理器：控制器解析 -> 请求体 -> onInit -> 动作 -> 自动响应
      const finalHandler = async (): Promise<void> => {
        if (!ctor) return notFound(res, route.controller);
        const instance = requestContainer.resolve(ctor) as BaseControllerLike;
        const actionName = `${route.action}Action`;
        const method = (instance as any)[actionName];
        if (typeof method !== 'function') {
          return notFound(res, `${route.controller}/${route.action}`);
        }
        if (
          req.method === HTTP_METHOD.POST ||
          req.method === HTTP_METHOD.PUT ||
          req.method === HTTP_METHOD.PATCH
        ) {
          await ctx.parseBody();
        }
        if (typeof instance.onInit === 'function') {
          await instance.onInit();
        }
        if (ctx.redirected || res.writableEnded) return;

        const result = await method.apply(instance, route.args);
        if (!res.writableEnded && !ctx.redirected) {
          if (result !== undefined) {
            ctx.echo(result);
          } else {
            notFound(res, `${route.controller}/${route.action}`);
          }
        }
        logger.debug(
          { requestId, route: routeLabel, durationMs: Date.now() - started },
          '动作完成',
        );
      };

      if (chain.length === 0) {
        await finalHandler();
      } else {
        await compose(chain, finalHandler)(ctx);
      }
    } catch (err: any) {
      this.handleError(res, err, debug, requestLog, requestId, req);
    }
  }

  private handleError(
    res: http.ServerResponse,
    err: unknown,
    debug: boolean,
    requestLog?: LoggerLike,
    requestId?: string,
    req?: http.IncomingMessage,
  ): void {
    const logger =
      requestLog ??
      this.loggerService ??
      (this.container.has(Logger) ? this.container.resolve(Logger) : undefined);
    const meta = {
      err,
      requestId,
      method: req?.method,
      path: req?.url,
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    };
    if (logger) logger.error(meta, '请求处理失败');
    else console.error('[ham] 请求处理失败:', err);

    if (res.writableEnded || res.headersSent) {
      res.destroy();
      return;
    }
    const body = debug && err instanceof Error ? err.stack : '服务器出现错误';
    res.writeHead(HTTP_STATUS.INTERNAL_SERVER_ERROR, {
      [HTTP_HEADER.CONTENT_TYPE]: CONTENT_TYPE.TEXT,
    });
    res.end(String(body));
  }
}

/** 生成/透传 X-Request-Id；客户端值需通过长度与字符集校验 */
function ensureRequestId(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): string {
  const raw = req.headers[HTTP_HEADER.REQUEST_ID.toLowerCase()];
  const incoming = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof incoming === 'string' ? incoming.trim() : '';
  const valid = /^[A-Za-z0-9._:-]{1,128}$/.test(trimmed);
  const existing = res.getHeader(HTTP_HEADER.REQUEST_ID);
  if (typeof existing === 'string' && existing) return existing;
  const id = valid ? trimmed : crypto.randomUUID();
  res.setHeader(HTTP_HEADER.REQUEST_ID, id);
  return id;
}

/** 在响应 finish/close 时按状态码输出访问日志 */
function attachAccessLog(
  log: LoggerLike,
  res: http.ServerResponse,
  route: string,
  started: number,
): void {
  let logged = false;
  const write = (aborted: boolean) => {
    if (logged) return;
    logged = true;
    const status = res.statusCode;
    const meta = {
      status,
      durationMs: Date.now() - started,
      route,
      ...(aborted ? { aborted: true } : {}),
    };
    if (aborted) {
      log.warn(meta, '请求中断');
    } else if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR) {
      log.error(meta, '请求完成');
    } else if (status >= HTTP_STATUS.BAD_REQUEST) {
      log.warn(meta, '请求完成');
    } else {
      log.info(meta, '请求完成');
    }
  };

  res.once('finish', () => write(false));
  res.once('close', () => write(!res.writableEnded));
}

function notFound(res: http.ServerResponse, what: string): void {
  if (res.writableEnded || res.headersSent) return;
  res.writeHead(HTTP_STATUS.NOT_FOUND, {
    [HTTP_HEADER.CONTENT_TYPE]: CONTENT_TYPE.TEXT,
  });
  res.end(`找不到网页: ${what}`);
}

/** 守卫拒绝且守卫未自行响应时的默认输出 */
function forbidden(res: http.ServerResponse, controller: string, action: string): void {
  if (res.writableEnded || res.headersSent) return;
  res.writeHead(HTTP_STATUS.FORBIDDEN, {
    [HTTP_HEADER.CONTENT_TYPE]: CONTENT_TYPE.TEXT,
  });
  res.end(`无权访问: ${controller}/${action}`);
}

interface BaseControllerLike {
  onInit?: () => unknown | Promise<unknown>;
  [action: string]: any;
}

/** 单个路由的预计算结果（不缓存实例，保证 request 作用域正确） */
interface RoutePlan {
  ctor: Type<any> | undefined;
  guardLikes: GuardLike[];
  interceptorLikes: InterceptorLike[];
}
