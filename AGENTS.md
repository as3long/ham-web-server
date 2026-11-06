# AGENTS.md

TypeScript 2.0 rewrite of `ham-web-server`: an IoC/MVC web framework plus three runnable example apps under `src/examples/`. Public API lives in `src/index.ts`; the build is also published as a library.

## Commands

Run from the repo root. Every script builds first.

- `npm run build` — `tsc -p tsconfig.json` then `node scripts/copy-assets.js`. This is the only typecheck; there is no lint or formatter config.
- `npm test` — build + `node --test dist/test/*.test.js` (67 tests).
- Single test file: `npm run build && node --test dist/test/guard.test.js`
- Single test by name: add `--test-name-pattern="Router"` to the `node --test` command.
- `npm run demo` (port 3000), `npm run board` (4320), `npm run dinner` (4321) — start example apps.
- E2E checks: `node scripts/verify-board.js`, `node scripts/verify-dinner.js`, `node scripts/verify-demo.js`. They spawn their own servers on ports 4320/4321/4319 and require `npm run build` first.
- `npm run bench` needs ApacheBench; on Windows it looks for `ab` in WSL Ubuntu-24.04, override with `AB=/path/to/ab`.
- `npm run bench:node` uses autocannon (no ab needed). It starts an isolated message-board via a temporary `BOARD_DB`; pass script flags with an extra `--`, e.g. `npm run bench:node -- -- --out data/bench-after.json`.

## Architecture

- `src/application.ts` — `HamApplication`: assembles container, router, middleware, HTTP server.
- `src/container/` — IoC container and decorators (`@Injectable`, `@Inject`, `@Autowired`, `@Controller`, `@UseInterceptors`, `@UseGuards`).
- `src/core/` — `Context`, `Router`, `StaticServer`, `SessionService`, `SessionStore`, interceptors, guards, body parsing.
- `src/database/` — `Database` + `QueryBuilder` + SQLite/MySQL drivers.
- `src/cluster.ts` — 内置多进程（`runCluster`）、PM2 环境检测（`isManagedProcess` / `isMultiProcessRuntime`）与主进程任务判断（`isPrimaryProcess` / `runOnce`）。
- `src/config/` — `ConfigService` plus `.env` loading and explicit `HAM_*` -> `HamConfig` mapping (`env.ts`).
- `src/logging/Logger.ts` — pino 日志器（JSON/pretty、文件、child、脱敏、close/flush）；`HamApplication` 的请求日志/错误日志/生命周期日志都走它。
- `src/constants.ts` — public `HTTP_STATUS` / `CONTENT_TYPE` / `HTTP_HEADER` / time-unit / route-default constants.
- `src/examples/{demo,message-board,dinner}/main.ts` — example entrypoints; their views/static assets are part of the build.
- `legacy/` — original 1.x JavaScript for reference only. Not compiled or tested; do not edit it expecting behavior changes.

Add every new public symbol to the export list in `src/index.ts`; the default export is the 1.x-compatible `Ham` facade.

## Repo-specific gotchas

- Tests run compiled JavaScript from `dist/test`, not TypeScript. Always build before testing; editing `src/` alone changes nothing.
- `npm run build` does not clean `dist/`. Stale compiled files persist (e.g. `dist/debug-manual.js` has no `src` counterpart). Delete `dist/` before rebuilding after renaming/removing modules, otherwise orphan tests may still run.
- `scripts/copy-assets.js` has a hardcoded directory list. New example view/static directories must be added there or `npm run demo|board|dinner` will 404 on assets/templates.
- `tsconfig.json` uses `rootDir: "src"`, so TypeScript outside `src/` will not compile. Files in `scripts/` are plain CommonJS and are not typechecked.
- Node >= 22.5 is required because the default SQLite driver uses built-in `node:sqlite`; `better-sqlite3` is optional.
- Decorator DI depends on `experimentalDecorators`, `emitDecoratorMetadata`, `"useDefineForClassFields": false`, and `import 'reflect-metadata'`. Do not change these.
- `data/` holds generated SQLite databases and server logs (gitignored). Verify scripts delete/reseed these files; never commit them. `scripts/bench-node.js` uses a separate `bench-node-<pid>.sqlite` and cleans it up.
- Session creation is lazy: `HamApplication` gives `Context` a Proxy that calls `SessionService.start()` on first property access. Requests that never touch `ctx.session` must not emit `Set-Cookie` or create a session; keep the `headersSent`/`writableEnded` skip so session access after `next()` cannot throw `ERR_HTTP_HEADERS_SENT`.
- Static files use `StaticServer.handleAsync()` with ETag/Last-Modified/304; the sync `handle()`/`resolve()` API is kept for compatibility and tests assert `resolve()` semantics exactly. Do not change its traversal checks.
- Prefer the exported constants (`HTTP_STATUS`, `HTTP_HEADER`, `CONTENT_TYPE`) over numeric status codes and header-name literals in framework code. Example apps keep domain constants (DI tokens, session keys, table names, statuses, limits) in `src/examples/<app>/constants.ts`; add new magic values there instead of inlining them.
- `HamApplication` loads `.env` in its constructor via Node's built-in `process.loadEnvFile` (default: `cwd/.env`, then `appPath/.env`; `envFile: false` disables). Real env vars win over `.env`, and explicit `config` wins over both. Only explicitly mapped `HAM_*` vars in `src/config/env.ts` become config; adding a `HamConfig` field requires adding its mapping and README entry.
- Logger 必须在 `SessionService` 之前注册（`registerDefaults` 中 Logger 在 Database/SessionService 之前），否则会话错误日志拿不到注入。`close()`/`gracefulShutdown()` 末尾必须关闭/刷新 Logger；`Logger.close()` 保持幂等。
- 请求 ID 由框架统一生成/透传（`X-Request-Id`、`ctx.requestId`）；示例不要再次实现 RequestIdInterceptor，否则会覆盖框架 ID。访问日志默认关闭，示例通过 `exampleLogRequests()` 默认开启，验证/压测脚本设置 `HAM_LOG_REQUESTS=0`。
- 日志库为 `pino` + `pino-pretty`；pretty 仅在 `logFormat=pretty` 且未设置 `logFile` 时使用，加载失败回退 JSON。不要记录请求体/Cookie/Session 数据；新增敏感字段时同步更新 `src/logging/Logger.ts` 的 redact 列表。
- 多进程下的“只执行一次”任务用 `isPrimaryProcess()` / `runOnce()`：`cluster.fork()` 会重新执行整个入口文件，因此写在 `runCluster(bootstrap)` 外面的代码**不能**保证只在主进程执行。PM2 用 `NODE_APP_INSTANCE` 判断实例（cluster 模式为实例号，fork 模式未设置），不要用 `pm_id`——它是所有 PM2 应用的全局计数器。选自进程不等于恰好执行一次，任务仍需幂等或加锁。
- Tests live in `src/test/*.test.ts` and use `node:test` + `assert/strict` with temporary directories. Name new tests `*.test.ts` so they compile into the `dist/test` glob.
- Comments, docs, test names, and user-facing messages are written in Chinese; keep that convention.
