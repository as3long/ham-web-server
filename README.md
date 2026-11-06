# ham-web-server 2.0

一个用 **TypeScript** 重构、内置 **IoC 容器**的 Node.js MVC Web 框架。

这是 [ham-web-server 1.x](https://www.npmjs.com/package/ham-web-server)（作者 as3long）的完全重构版：
保留了 1.x 的 ThinkPHP 风格开发体验（伪静态路由、链式 ORM、模板渲染、表单/上传/会话），
去掉了全局变量魔法，引入了现代化的依赖注入体系。

## 特性

- **TypeScript 全量重写**：严格模式、完整类型声明（`dist/*.d.ts`）
- **IoC 容器**：`@Injectable` / `@Inject` / `@Autowired` / `@Controller` 装饰器，
  支持单例 / 瞬态 / 请求（request）三种作用域、循环依赖检测
- **拦截器（AOP）**：洋葱模型 `compose`，全局 / 控制器级 / 动作级三级作用域，
  支持短路、错误捕获、函数式写法，拦截器类经 IoC 解析可注入服务
- **守卫（Guard）**：`canActivate` 放行/拒绝模型，先于拦截器与请求体解析执行，
  拒绝可自行响应（默认 403）；与拦截器同一套三级作用域与自动注册机制
- **ThinkPHP 风格路由**：`/user/list.html` → `UserController.listAction()`
- **链式 ORM**：SQLite（Node 内置 `node:sqlite`，零原生依赖）与 MySQL（mysql2 连接池）
- **配置**：零依赖加载 `.env`（Node 内置 `process.loadEnvFile`）+ 显式 `HAM_*` 环境变量映射，
  `config` 参数 > 环境变量 > 默认值的清晰优先级
- **日志**：基于 pino 的结构化日志，支持请求 ID、访问/错误日志、敏感字段脱敏、
  开发环境 pretty 输出与可选文件输出，适配 PM2
- **多进程**：内置 `runCluster`（自动 fork / 重启 / 信号转发）并兼容 PM2，
  `isPrimaryProcess()` / `runOnce()` 支持“只在主进程执行一次”的任务
- **安全修复**（相对 1.x）：
  - 静态资源路径穿越（`/../` 逃逸）已修复，且 views 目录不再对外可读
  - SQL 值全部参数化，标识符（表名/列名）做白名单校验
  - Session Cookie 默认 `HttpOnly + SameSite=Lax`
  - 控制器/请求上下文每请求新建，修复 1.x 实例复用导致的并发状态污染
- 表单/multipart/JSON 请求体解析（formidable 3），字段 XSS 过滤（xss）
- art-template 视图引擎、手写 LRU 查询缓存、内存/数据库会话（多进程可共享）

## 快速开始

```bash
npm install
npm run build   # 编译到 dist/
npm run demo    # 启动示例应用（默认 3000 端口，可用环境变量 PORT 覆盖）
npm run board   # 启动留言板示例（默认 4320 端口）
npm run dinner  # 启动点餐系统示例（默认 4321 端口）
npm run bench   # 用 ab 压测留言板（自动寻找 ab：优先 WSL 中的 apache2-utils）
npm run bench:node  # 用 autocannon 压测留言板（纯 Node，无需 ab）
npm test        # 编译并运行全部测试（67 个用例）
```

示例应用：`/`（首页） · `/user`（用户列表） · `/user/add`（添加用户） · `/user/api/1`（JSON 接口） · `/index/time`

## 完整例子：留言板

[`src/examples/message-board`](src/examples/message-board) 是一个功能完整的留言板，演示了
服务注入、会话、分页、表单/JSON 双接口、XSS 过滤与静态资源：

| URL | 说明 |
| --- | --- |
| `GET /board/` | 留言列表（`?page=2` 分页）；未登录只读 |
| `POST /board/add` | 发表留言 —— 需登录（FormLoginGuard）+ 限流（管理员豁免） |
| `GET /board/api?page=&size=` | JSON 分页接口 |
| `POST /board/apiAdd` | JSON 发表 —— 需登录（ApiLoginGuard），仅收 application/json（否则 415） |
| `GET/POST /board/register` | 注册（成功后自动登录；**第一个注册的用户自动成为管理员**） |
| `GET/POST /board/login` | 登录 |
| `GET /board/logout` | 登出 |
| `GET/POST /board/password` | 修改密码 —— 需登录 |
| `POST /board/adminDelete?id=` | 删除任意留言 —— 仅管理员（AdminGuard），非管理员 403 |

```ts
@Injectable()
export class MessageService {
  constructor(private db: Database) {}          // 注入框架的数据库服务

  async pageList(pageNo: number, size = 10) {
    const total = await this.db.table<MessageRow>('messages').count();
    const list = await this.db.table<MessageRow>('messages')
      .order('id', 'DESC').page(page, size).select();
    return { list, total, page, size, pages: Math.ceil(total / size) };
  }

  async add(nickname: string, content: string, ip = '') {
    return (await this.db.table<MessageRow>('messages')
      .add({ nickname, content, ip, createdAt: Date.now() })).insertId;
  }
}

@Controller('board')
export class MessageBoardController extends BaseController {
  constructor(ctx: Context, private messages: MessageService) { super(ctx); }

  async indexAction() {
    const data = await this.messages.pageList(Number(this.get('page')) || 1);
    this.assign({ ...data, nickname: this.session.nickname ?? '' }); // 会话记住昵称
    this.display('board/list');
  }

  async addAction() {                            // POST /board/add
    const nickname = (this.post('nickname') ?? '').trim() || '匿名';
    const content = (this.post('content') ?? '').trim();
    this.session.nickname = nickname;
    await this.messages.add(nickname, content, this.ctx.raw.socket.remoteAddress ?? '');
    this.redirect('/board/?posted=1');
  }

  async apiAction() {                            // GET /board/api —— 直接返回对象 => JSON
    return { ok: true, ...(await this.messages.pageList(1)) };
  }
}
```

留言板同时是拦截器与守卫的实战示例（见 [`interceptors/`](src/examples/message-board/interceptors) 与 [`guards/`](src/examples/message-board/guards)）：

| 拦截器 | 挂载位置 | 作用 |
| --- | --- | --- |
| `RateLimitInterceptor` | 动作级（`addAction` 上） | 按 IP 固定窗口限流（配置经 `@Inject(TOKEN.RATE_LIMIT)` 注入），超限 429 短路；**管理员豁免** |
| `JsonOnlyInterceptor` | 动作级（`apiAddAction` 上） | 请求体校验：非 application/json 直接 415，在解析请求体前拒绝 |

请求日志与 `X-Request-Id` 已由框架统一处理（见“日志”章节），示例不再维护独立的
`RequestLogInterceptor` / `RequestIdInterceptor`。

| 守卫 | 挂载位置 | 作用 |
| --- | --- | --- |
| `BannedIpGuard` | 控制器级（类上 `@UseGuards`） | POST 写操作按 IP 黑名单拒绝（名单经 `@Inject(TOKEN.BANNED_IPS)` 注入），命中输出默认 403 |
| `FormLoginGuard` | `add` / `password` 动作级 | 未登录 -> 302 登录页（浏览器路径，体验优先） |
| `ApiLoginGuard` | `apiAdd` 动作级 | 未登录 -> 401 JSON（程序化调用方优先） |
| `AdminGuard` | `adminDelete` 动作级 | 未登录 302 登录页；非管理员框架默认 403 |
| 全局函数式守卫 | 全局（`app.addGuard`） | 拦下查询参数中的 `<script`/`<iframe` 注入尝试，默认 403 |

### 用户系统与管理员

- 密码经 Node 内置 **scrypt + 随机盐**哈希存储（`timingSafeEqual` 比对防时序攻击），不存明文
- 登录态存于框架会话：`session.data = { userId, username, isAdmin }`（Cookie 默认 HttpOnly + SameSite=Lax）
- **管理员标志与最大化权限**：
  - 用户表为空时，**第一个注册的用户自动 `isAdmin=1`**（页面有徽标标识）
  - 其发布的留言在列表中带**管理员徽标**（发帖时身份快照存入留言行，历史留言不随身份变化）
  - 可删除**任意**留言（列表页每条留言带删除按钮，仅管理员可见）
  - 可查看留言者 IP（普通用户不可见）
  - 豁免留言限流 —— 守卫先确认登录态，拦截器读会话即可拿到身份
- 未登录不能留言：`POST /board/add` 302 去登录页，`POST /board/apiAdd` 返回 401

功能验证：`node scripts/verify-board.js`（26 步断言：未登录拒绝 / 注册登录改密全流程 / 管理员权限 / 415 / 429 / 403）。

## 完整例子：点餐系统

[`src/examples/dinner`](src/examples/dinner) 是第二个完整应用：顾客点菜下单拿取餐号，店主在后台接单出餐、维护菜单。
与留言板不同，它**无需顾客注册**（会话即一桌客人），管理侧只有一道口令，重点演示
**事务下单、服务端计价、状态机、类级守卫 + 动作豁免**。

| URL | 说明 |
| --- | --- |
| `GET /dinner/` | 菜单（12 道种子菜品，按 4 个分类分组），顶部显示购物车件数 |
| `POST /dinner/cartAdd` | 加入购物车（`dishId`），**加完留在菜单页**（提示 + 角标即时更新，锚点回到该菜品）；下架/不存在的菜品被拒 |
| `GET /dinner/cart` | 购物车（行内改数量 / 移除 / 清空） |
| `POST /dinner/cartUpdate` | 改数量（`qty=0` 即移除） |
| `POST /dinner/cartClear` | 清空购物车 |
| `POST /dinner/orderSubmit` | 提交订单（`customer`、`tableNo`）→ 302 取餐页 |
| `GET /dinner/order/5` | 订单详情（路径参数） |
| `GET /dinner/order?no=N1001` | 凭取餐号查单 |
| `GET/POST /dinner-admin/login` | 店主登录（口令 `admin123`，环境变量 `DINNER_ADMIN_PASSWORD` 覆盖） |
| `GET /dinner-admin/` | 订单管理（最近订单 + 接单 / 取消 / 出餐按钮） |
| `POST /dinner-admin/orderStatus` | 状态流转（`orderId`、`to`） |
| `GET /dinner-admin/dishes` | 菜品管理（`?edit=5` 表单预填） |
| `POST /dinner-admin/dishSave` | 新增 / 保存菜品（`id=0` 为新增） |
| `POST /dinner-admin/dishToggle` | 上架 / 下架 |
| `POST /dinner-admin/dishDelete` | 删除菜品 |

```ts
@Controller('dinner-admin')
@UseGuards(AdminLoginGuard)          // 类级守卫：整个后台默认受保护
export class AdminController extends BaseController {
  constructor(
    ctx: Context,
    private menu: MenuService,
    private orders: OrderService,
    @Inject(TOKEN.ADMIN_PASSWORD) private adminPassword: string,   // 令牌见 examples/dinner/constants.ts
  ) { super(ctx); }
}

@Injectable()
export class AdminLoginGuard implements Guard {
  canActivate(ctx: Context): boolean {
    if (ctx.action === 'login') return true;      // 登录动作豁免，避免重定向死循环
    if (ctx.session.data.dinnerAdmin === true) return true;
    ctx.redirect('/dinner-admin/login');          // 守卫内直接响应
    return false;
  }
}
```

订单落库（[`OrderService.ts`](src/examples/dinner/services/OrderService.ts)）的关键点：

```ts
async createOrder(cart, customer, tableNo) {
  const dishes = await this.menu.availableByIds(cart.map((c) => c.dishId));
  if (dishes.length === 0) throw new Error('购物车为空或菜品均已下架');
  const totalPrice = lines.reduce((s, l) => s + l.dish.price * l.quantity, 0); // 服务端重新计价

  this.db.exec('BEGIN');
  try {
    const seq = (await this.db.table('orders').count()) + 1;
    const inserted = await this.db.table('orders').add({ orderNo: `N${1000 + seq}`, ... });
    for (const line of lines) await this.db.table('order_items').add({ orderId: inserted.insertId, ... });
    this.db.exec('COMMIT');
    return (await this.byId(inserted.insertId))!;
  } catch (err) { this.db.exec('ROLLBACK'); throw err; }   // 主表/明细要么全写，要么全不写
}

async setStatus(id, to) {                                     // 状态机：0→[1,3]，1→[2]
  const allowed = { 0: [1, 3], 1: [2] };
  if (!(allowed[order.status] ?? []).includes(to)) return `不允许的操作：...`;
  ...
}
```

设计要点：

- **会话购物车**：`session.data.cart = { [dishId]: qty }`，纯服务端实现（换浏览器 = 换一桌客人），无需登录也不怕篡改前端
- **服务端计价 + 事务**：前端只提交菜品 id 与数量，价格按当前菜单重算，订单主表与明细放在同一事务里
- **价格以「分」为整数存储**：`12.50 元 → 1250 分`，展示层 `centsToYuan()` 格式化，彻底避开浮点误差
- **菜品快照**：订单明细保存下单时的菜名与单价，菜品后续改名/改价/删除都不影响历史订单
- **取餐号**：`N${1000 + 订单数}`，顾客凭号查单（`/dinner/order?no=N1001`）
- **状态机**：待接单 → 制作中 → 已完成；仅待接单可取消，非法流转给出提示且不改库
- **类级守卫 + 动作豁免**：`@UseGuards(AdminLoginGuard)` 挂在类上覆盖全部动作，守卫内用 `ctx.action === 'login'` 放行登录页
- 口令比对用 `crypto.timingSafeEqual`（先比长度），口令经 `registerValue` 注入，不硬编码在控制器里

功能验证：`node scripts/verify-dinner.js`（32 步断言：菜单/购物车增改/类级守卫/口令登录/事务下单 +
DB 校验总价与明细/状态机合法与非法流转/菜品增改上下架删/空车下单/404/登出）。

## ab 压测结果

环境：Windows 11 · Node.js v24.15.0（单进程） · SQLite（node:sqlite, WAL） ·
ab 2.3 运行于 WSL2 Ubuntu 24.04，经 NAT 网关访问宿主机服务 · 每例 2000 请求（POST 500）

```
用例                                          RPS     均值延迟    p99     失败
留言板首页 HTML   /board/        c=50       2112    23.7 ms    360 ms      0
JSON 分页接口     /board/api     c=50       3052    16.4 ms    220 ms      0
JSON 分页接口     /board/api     c=10       2679     3.7 ms     60 ms      0
JSON 分页接口     /board/api     c=100      2593    38.6 ms    540 ms      0
JSON 接口 keepalive c=50                    2382    21.0 ms    320 ms      0
发表留言 POST     /board/apiAdd  c=20       1411    14.2 ms     64 ms     413*
```

\* ab 会把"响应体长度与首个响应不同"的请求计为 Failed（`{"ok":true,"id":N}` 的 id
位数会变化），失败明细为 `Connect: 0, Receive: 0, Length: 413, Exceptions: 0`，
即全部为 ab 的长度统计口径，非真实错误；服务端日志无任何异常。

上表为**开启 4 个拦截器 + 4 个守卫、留言接口要求登录**后的结果（POST 用例经
`ab -C` 携带管理员会话 Cookie；debug 关闭，日志拦截器零输出）。守卫 + 会话校验
在每请求路径上只增加一次内存 Map 读取，开销可忽略；更早未加拦截器/守卫时的
结果为 1931 / 2938 / 1518 RPS，量级一致。p99 波动主要来自 WSL2 NAT 跨机压测的抖动。

复现：`npm run bench`（自动探测 WSL 中的 ab 与网关 IP；也可用 `AB=/path/to/ab` 指定）。
上表来自优化前的构建，保留作为历史对照。

## Node 基准（autocannon）

`npm run bench:node` 用 `autocannon` 启动独立的留言板实例（`BOARD_DB` 指向临时 SQLite，
不污染开发库），对三类热点各预热 3s 后重复 3 次，取 RPS / p50 / p99 中位数：

```bash
npm run bench:node
# 输出 JSON：多一层 -- 让 npm 把参数透传给脚本
npm run bench:node -- -- --out data/bench-after.json
```

环境：Windows 11 · Node.js v24.15.0（单进程）· SQLite（node:sqlite, WAL）·
autocannon 8 · 50 并发 · 每场景 10s · 3 次中位数。

| 场景 | 优化前 RPS | 优化后 RPS | 优化前 p99 | 优化后 p99 |
| --- | ---: | ---: | ---: | ---: |
| `GET /board/api?size=10` | 954 | 9933 | 64 ms | 7 ms |
| `GET /board/` | 471 | 4419 | 132 ms | 15 ms |
| `GET /static/style.css` | 2896 | 3062 | 26 ms | 26 ms |

优化前 `/board/api` 与 `/board/` 的吞吐随压测轮次持续下降，主要来自每请求创建 Session
并对全部会话做一次 O(n) 过期扫描；改为惰性创建 + 定时清理后该热点消失。静态资源吞吐
基本持平并略有提升（异步 stat + ETag 条件请求，p99 未变化）。

## 用你的应用使用本框架

```bash
npm install ham-web-server
```

```
my-app/
├── config.ts        # 可选：覆盖默认配置
├── controllers/     # 控制器
├── services/        # 业务服务（@Injectable）
├── views/           # art-template 模板（默认 .html）
├── static/          # 静态资源（URL 前缀 /static/）
└── main.ts          # 入口
```

```ts
// main.ts
import 'reflect-metadata';
import { HamApplication, Database, Injectable, Controller, BaseController, Context } from 'ham-web-server';
import { IndexController, UserController } from './controllers';
import { UserService } from './services';

// 1) 服务：@Injectable 即可在任何地方构造函数注入
@Injectable()
export class UserService {
  constructor(private db: Database) {}
  list() { return this.db.table('user').order('id', 'DESC').limit(10).select(); }
}

// 2) 控制器：继承 BaseController，动作方法以 Action 结尾
@Controller('index')
export class IndexController extends BaseController {
  constructor(ctx: Context, private users: UserService) { super(ctx); }
  async indexAction() {
    this.assign('users', await this.users.list());
    this.display('index');            // 渲染 views/index.html
  }
  async timeAction() {                // 动作直接返回对象 => 自动输出 JSON
    return { now: Date.now() };
  }
}

// 3) 组装并启动
const app = new HamApplication({
  appPath: __dirname,
  config: { dbType: 'sqlite', sqlitePath: 'data/app.sqlite', port: 3000 },
});
app.register(UserService);            // 单例服务
app.registerValue('APP_VERSION', '2.0.0');
app.addController(IndexController);
app.addController(UserController);
app.listen();                         // 端口优先级：listen 参数 > PORT 环境变量 > config.port
```

## IoC 容器

```ts
import { Injectable, Inject, Autowired } from 'ham-web-server';

@Injectable({ scope: 'singleton' })          // 默认单例
export class OrderService {}

@Injectable({ scope: 'transient' })          // 每次解析新建
export class Task {}

@Injectable({ scope: 'request' })            // 每请求一个实例（仅请求容器可解析）
export class CurrentUser {}

@Injectable()
export class BillingService {
  constructor(
    private orders: OrderService,            // 按类令牌自动注入
    @Inject('APP_VERSION') version: string,  // 字符串令牌需 @Inject 显式声明
  ) {}

  @Autowired(Database)                        // 属性注入（可选）
  private db!: Database;
}
```

容器 API（`app.container`）：

| 方法 | 说明 |
| --- | --- |
| `registerClass(Type, scope?)` | 注册类，缺省读取 `@Injectable` 的作用域 |
| `registerValue(token, value)` | 注册常量 |
| `registerFactory(token, fn, scope?)` | 注册工厂 `(container) => any` |
| `resolve<T>(token)` | 解析（含父容器查找、循环依赖检测） |
| `createRequestContainer()` | 创建请求级子容器（框架在每次请求时自动调用） |

作用域规则：
- `singleton`：实例缓存在根容器，整个进程共享
- `transient`：每次 `resolve` 都新建
- `request`：缓存在请求子容器中，请求结束即释放；**不能**注入到单例服务（会抛出明确错误）

## 拦截器（AOP）

拦截器以洋葱模型包裹请求处理过程，适合承载鉴权、限流、日志、链路追踪、异常兜底等横切逻辑。

```ts
import { Interceptor, Next, UseInterceptors, Injectable, Context } from 'ham-web-server';

// 1) 类形式：经 IoC 容器解析，构造函数可注入任意服务（声明即用，无需手工注册）
@Injectable()
export class AuthInterceptor implements Interceptor {
  async intercept(ctx: Context, next: Next): Promise<void> {
    if (ctx.get('token') !== 'secret') {
      ctx.echo({ ok: false, error: 'unauthorized' }, 401);
      return;                       // 不调用 next() => 短路，动作不会执行
    }
    await next();
  }
}

// 2) 函数形式：轻量场景不想定义类时
const timer = async (ctx: Context, next: Next) => {
  await next();
  console.log(`${ctx.url.pathname} ${ctx.res.statusCode} ${ctx.useTime}ms`);
};

@Controller('admin')
@UseInterceptors(AuthInterceptor)   // 控制器级：本控制器全部动作
export class AdminController extends BaseController {
  @UseInterceptors(timer)           // 动作级：仅本动作
  async delAction() { /* ... */ }
}

const app = new HamApplication({ appPath: __dirname });
app.addInterceptor(timer);          // 全局：所有 MVC 请求（静态资源除外）
```

要点：

| 特性 | 说明 |
| --- | --- |
| 三级作用域 | 全局 → 控制器级 → 动作级；洋葱模型，越靠内越贴近动作 |
| 短路 | 不调用 `next()` 并自行响应（`ctx.echo` / `ctx.redirect`）即终止后续处理 |
| 错误处理 | 动作或内层抛错沿 `await next()` 向外传播，外层可 `try/catch` 兜底；无人捕获时框架输出 500 |
| 依赖注入 | 类拦截器经 IoC 解析（singleton / transient / request 均可），支持 `@Inject('TOKEN')` |
| 自动注册 | `@UseInterceptors` / `addInterceptor` 中引用的拦截器类无需提前注册，框架自动登记（幂等） |
| 执行时机 | 拦截器先于动作与请求体解析运行 —— 可在解析前就拒绝请求（如 415 / 429） |
| 防误用 | 同一拦截器内重复调用 `next()` 会抛出明确错误 |

留言板中的实战见 [`src/examples/message-board/interceptors`](src/examples/message-board/interceptors)。

## 守卫（Guard）

守卫回答“请求能不能进”，拦截器回答“进出时做什么”。适合鉴权、授权、IP 黑名单等访问控制。

```ts
import { Guard, UseGuards, Injectable, Inject, Context } from 'ham-web-server';

// 类形式：经 IoC 容器解析，构造函数可注入服务。
// 返回 false 且未自行响应时，框架输出默认 403 文本；先自行响应则用之。
@Injectable()
export class AdminTokenGuard implements Guard {
  constructor(@Inject('ADMIN_TOKEN') private expected: string) {}
  canActivate(ctx: Context): boolean {
    if (ctx.get('token') === this.expected) return true;
    ctx.echo({ ok: false, error: '需要管理员令牌' }, 401); // 自行响应（可选）
    return false;                                          // 拒绝：动作与拦截器都不会执行
  }
}

@Controller('admin')
@UseGuards(AdminRoleGuard)          // 控制器级：本控制器全部动作
export class AdminController extends BaseController {
  @UseGuards(AdminTokenGuard)       // 动作级：仅本动作
  async delAction() { /* ... */ }
}

const app = new HamApplication({ appPath: __dirname });
app.addGuard(async (ctx) => !ctx.url.pathname.startsWith('/internal')); // 全局函数式守卫
```

要点：

| 特性 | 说明 |
| --- | --- |
| 执行顺序 | 全局 → 控制器级 → 动作级，依次短路；**先于拦截器与请求体解析执行**（拦截器短路绕不过守卫） |
| 拒绝方式 | 返回 `false`：已自行响应（`ctx.echo` / `ctx.redirect`）则用之，否则框架默认 403 文本 |
| 三种形态 | 类（IoC 解析，可 DI）/ 实例 / `(ctx) => boolean` 函数（支持 async） |
| 自动注册 | `@UseGuards` / `addGuard` 引用的守卫类无需提前注册，框架自动登记（幂等） |
| 守卫 vs 拦截器 | 访问控制（能不能进）用守卫；限流、日志、改响应头、异常兜底（进出时做什么）用拦截器 |
| 与 NestJS 的差异 | 不依赖异常流：拒绝即返回布尔值，响应方式显式可控 |

留言板中的实战（`AdminTokenGuard` / `BannedIpGuard` / 全局函数式守卫）见
[`src/examples/message-board/guards`](src/examples/message-board/guards)。

## 会话

会话通过 Cookie（默认 `ham_session_id`，`HttpOnly` + `SameSite=Lax`）关联。
默认 `sessionStore='memory'`，数据保存在进程内存；多进程/PM2 可设置
`sessionStore='database'`，将会话写入数据库（表名 `dbPrefix + 'session'`，默认 `ham_session`）共享：

```ts
async indexAction() {
  this.session.viewCount = (this.session.viewCount ?? 0) + 1; // 首次读写即创建会话
}
```

要点：

- **惰性创建**：请求未访问 `ctx.session`（或 `BaseController.session`）时不会创建会话，
  也不会下发 Session Cookie。纯 JSON 接口、静态资源与 404 不再产生无用的会话与 Cookie。
- **新建才写 Cookie**：复用已有会话的请求不会重复下发 `Set-Cookie`。
- **写入时机安全**：如果拦截器在 `next()` 之后才首次访问 session，此时响应头已发送，
  框架会返回会话但跳过 `Set-Cookie`，不会抛 `ERR_HTTP_HEADERS_SENT`。
- **容量与清理**：`sessionMax` 限制内存会话数量（按插入顺序淘汰最旧，仅 memory 存储生效），
  `sessionCleanupInterval` 控制后台过期清理周期（`unref` 定时器，不阻止进程退出）；
  database 存储按 TTL 自动清理。
- `ctx.session.data = {}` 可清空会话数据（登录/登出场景）。
- 多进程下必须使用 `sessionStore='database'`；memory 存储的会话不会跨 worker 共享。

## 日志

框架内置基于 [pino](https://getpino.io/) 的日志系统，默认输出 JSON（适合 PM2 / 日志采集），
`debug=true` 时自动使用 `debug` 级别和 pretty 格式。日志器可通过 `app.logger` 获取，
也可以直接注入 `Logger`：

```ts
import { HamApplication, Logger } from 'ham-web-server';

const app = new HamApplication({
  appPath: __dirname,
  config: { logLevel: 'info', logRequests: true },
});

const logger = app.logger.child({ module: 'order' });
logger.info({ orderId: 1 }, '订单创建');
logger.error({ err }, '订单创建失败');

@Injectable()
class OrderService {
  constructor(private logger: Logger) {}

  create() {
    this.logger.info({ orderId: 1 }, '创建订单');
  }
}
```

请求日志：

- 每个请求自动生成或透传 `X-Request-Id`，并暴露为 `ctx.requestId`；
  客户端传入的合法 ID 会被复用，否则生成 UUID。
- `logRequests=true` 时输出访问日志，字段包括 `requestId`、`method`、`path`、
  `route`、`status`、`durationMs`、`ip`。
- 2xx/3xx 使用 info，4xx 使用 warn，5xx 与未捕获异常使用 error；客户端中断记录 warn + `aborted: true`。
- 静态资源不输出访问日志，但响应仍带 `X-Request-Id`。

错误日志示例：

```json
{"level":"error","service":"ham","pid":123,"worker":"single","requestId":"...","method":"GET","path":"/boom","status":500,"err":{"type":"Error","message":"...","stack":"..."},"msg":"请求处理失败"}
```

配置与行为：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `logLevel` | `'auto'` | `auto` 时 debug=true 用 `debug`，否则 `info`；可选 trace/debug/info/warn/error/fatal/silent |
| `logFormat` | `'auto'` | `auto` 时 debug=true 用 `pretty`，否则 `json`；`logFile` 非空时强制 JSON |
| `logRequests` | `false` | 是否输出 HTTP 访问日志；示例应用默认开启 |
| `logFile` | `''` | 日志文件路径（相对 appPath）；为空输出 stdout |

- **脱敏**：`password`、`passwordHash`、`salt`、`token`、`authorization`、`cookie`
  及常见嵌套字段默认输出为 `[REDACTED]`；框架不记录请求体、Cookie、Session 数据。
- **文件日志**：目录自动创建；不负责日志轮转，多 worker 写同一文件时需要外部收集/轮转方案。
  PM2 场景推荐保持 stdout JSON，用 `pm2 logs` 查看。
- **自定义 logger**：`new HamApplication({ appPath, logger })` 或 `app.setLogger(logger)`
  （必须在 `listen()` / 首次访问 logger 之前）；自定义实现需满足 `LoggerLike` 接口。
- 三个示例应用默认开启访问日志；验证/压测脚本通过 `HAM_LOG_REQUESTS=0` 关闭。
- 当前未提供数据库 SQL/慢查询日志。

## 多进程与 PM2

框架不强制多进程，按需选择两种方式：

```ts
import { runCluster } from 'ham-web-server';

// 内置 cluster：非 PM2 环境下由主进程 fork N 个 worker
// （WORKERS / HAM_WORKERS / WEB_CONCURRENCY 或 options.workers），
// 异常退出自动重启，转发 SIGINT/SIGTERM 并支持优雅关闭
await runCluster(() => app.listen(3000), { workers: 4 });

// PM2 环境下 runCluster 直接执行 bootstrap，fork 交给 PM2（instances: 4）
```

只在主进程执行一次的任务（定时器、缓存预热、数据迁移）用 `isPrimaryProcess()` / `runOnce()`：

```ts
import { isPrimaryProcess, runOnce } from 'ham-web-server';

if (isPrimaryProcess()) startScheduler();

await runOnce(() => warmupCache()); // 非主进程直接跳过，返回 undefined
```

判断规则：

| 运行形态 | 承担一次性任务的进程 |
| --- | --- |
| 单进程 | 当前进程 |
| 内置 cluster | 主进程（不执行 bootstrap，只负责 fork） |
| PM2 cluster 模式 | 实例 0（`NODE_APP_INSTANCE === '0'`） |
| PM2 fork 模式（单实例） | 当前进程（未设置实例号） |

要点：

- `cluster.fork()` 会重新执行整个入口文件，把任务写在 `runCluster(bootstrap)` 外面
  **不能**保证只在主进程执行，必须用上述 API 显式判断。
- **“选进程”不等于“恰好一次”**：PM2 实例 0 重启时任务会再次执行，任务本身仍需幂等或加锁
  （可参考示例里的 `ham_seed` 标记 + 事务写法）。
- 不要用 `pm_id === '0'` 判断实例：`pm_id` 是所有 PM2 应用的全局计数器，不是实例号。
- 独占型后台任务（消息消费者、长定时器）更推荐拆成独立的 PM2 应用
  （`instances: 1`、不监听端口），web 服务用 cluster 模式，彻底免去进程判断。
- 多进程下会话必须使用 `sessionStore='database'`（见[会话](#会话)）。

## 路由约定

| URL | 控制器/动作 | 参数 |
| --- | --- | --- |
| `/` | `index/indexAction` | — |
| `/user` | `user/indexAction` | — |
| `/user/list.html` | `user/listAction`（伪静态后缀自动剥离） | — |
| `/user/api/5` | `user/apiAction` | `['5']`（URI 解码） |

- 控制器名取自 `@Controller('name')`，缺省为类名去 `Controller` 后缀并小写
- 每个请求创建新的控制器实例；构造函数注入 `Context` 与所需服务
- `onInit()` 钩子：动作执行前调用（可异步），重定向后后续流程自动终止
- 动作返回非 `undefined` 值时自动输出（对象 → JSON，字符串 → text/plain）；
  未响应任何内容则返回 404（修复 1.x 的请求悬挂问题）

## ORM

```ts
const db: Database = /* 注入 */;

// 查询（值全部参数化；表名/列名做格式校验）
await db.table('user').where({ status: 1 }).order('id', 'DESC').page(1, 10).select();
await db.table<User>('user').where('id', 5).find();          // 单条 | null
await db.table('user').where('age', '>', 18).count();        // 运算符条件
await db.table('user').cache().select();                     // 走 LRU 缓存（sqlCacheTime）
await db.table('user')
  .field('u.id', 'p.city')
  .join('profile', 'userId', 'id')                           // INNER JOIN，自动加前缀
  .select();

// 写入
await db.table('user').add({ name: '张三', createdAt: Date.now() });
await db.table('user').where({ id: 1 }).update({ name: '李四' }); // 无 where 会抛错
await db.table('user').where({ id: 1 }).delete();                // 无 where 会抛错

// DDL
await db.exec('CREATE TABLE IF NOT EXISTS ham_user (...)');
```

驱动：
- `sqlite`（默认）：Node.js ≥ 22.5 内置 `node:sqlite`；也可安装可选依赖 `better-sqlite3`
- `mysql`：mysql2 连接池（`dbHost/dbPort/dbName/dbUser/dbPwd/dbCharset/dbConnLimit`）

## 配置

`new HamApplication({ appPath, config })` 中的 `config` 覆盖以下默认值
（完整定义见 `src/types.ts` 的 `HamConfig`）。优先级从高到低为：
**`config` 参数 > 环境变量（含 `.env`）> 默认值**；`port` 另保留
`listen(port)` > `PORT` 环境变量 > `config.port` 的既有语义。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `port` | `3000` | 监听端口（`PORT` 环境变量优先） |
| `debug` | `false` | 调试模式：500 返回堆栈、关闭模板缓存；`logLevel/logFormat=auto` 时影响日志级别/格式 |
| `logLevel` | `'auto'` | 日志级别；`auto` 时 debug 用 debug，否则 info |
| `logFormat` | `'auto'` | `json` / `pretty`；`auto` 时 debug 用 pretty，否则 json |
| `logRequests` | `false` | 是否输出 HTTP 访问日志 |
| `logFile` | `''` | 日志文件路径（相对 appPath）；空为 stdout |
| `dbType` | `'sqlite'` | `'sqlite' \| 'mysql'` |
| `sqlitePath` | `'ham.sqlite'` | 相对路径基于 appPath |
| `dbPrefix` | `'ham_'` | 表前缀（沿用 1.x） |
| `sqlCacheTime` | `600000` | 查询缓存 TTL（毫秒） |
| `sessionExpires` | `1800000` | 会话有效期（毫秒） |
| `sessionKey` | `'ham_session_id'` | 会话 Cookie 名 |
| `sessionStore` | `'memory'` | `'memory' \| 'database'`；多进程使用 `database` |
| `sessionMax` | `10000` | 内存会话上限（按插入顺序 LRU 淘汰；database 忽略） |
| `sessionCleanupInterval` | `60000` | 过期会话后台清理周期（毫秒，`0` 关闭） |
| `shutdownTimeout` | `10000` | 优雅关闭等待上限（毫秒） |
| `staticDir` / `viewDir` / `tempDir` | `'static'` / `'views'` / `'.ham-temp'` | 目录约定 |
| `staticMaxAge` | `120000` | 静态资源 `Cache-Control: max-age`（毫秒） |
| `keepAliveTimeout` | `65000` | HTTP keep-alive 空闲超时（毫秒） |
| `headersTimeout` | `66000` | HTTP 请求头超时（毫秒，需大于 `keepAliveTimeout`） |
| `requestTimeout` | `30000` | HTTP 请求总超时（毫秒） |
| `enableXss` | `true` | 表单字段 XSS 过滤 |
| `maxBodySize` | `10MB` | 请求体上限 |

### `.env` 与 `HAM_*` 环境变量

`HamApplication` 构造时自动加载 `.env`（使用 Node 内置 `process.loadEnvFile`，无额外依赖）：

- 默认依次查找 `process.cwd()/.env`、`appPath/.env`，加载第一个存在的文件；
- `new HamApplication({ appPath, envFile: '/path/to/.env' })` 可显式指定（相对路径基于 `appPath`）；
- `envFile: false` 关闭自动加载；
- **真实进程环境变量优先于 `.env`**（`process.loadEnvFile` 不覆盖已存在的变量）；
- **显式 `config` 参数优先级最高**，可覆盖环境变量；
- 数值/布尔变量解析失败时会立即抛错，并指出具体变量名。

框架识别的变量（未设置时使用默认值）：

- 基础：`HAM_PORT`、`HAM_DEBUG`
- 日志：`HAM_LOG_LEVEL`、`HAM_LOG_FORMAT`、`HAM_LOG_REQUESTS`、`HAM_LOG_FILE`
- 数据库：`HAM_DB_TYPE`、`HAM_SQLITE_PATH`、`HAM_DB_HOST`、`HAM_DB_PORT`、`HAM_DB_NAME`、
  `HAM_DB_USER`、`HAM_DB_PWD`、`HAM_DB_PREFIX`、`HAM_DB_CHARSET`、`HAM_DB_CONN_LIMIT`、`HAM_SQL_CACHE_TIME`
- 会话与关闭：`HAM_SESSION_EXPIRES`、`HAM_SESSION_KEY`、`HAM_SESSION_STORE`、`HAM_SESSION_MAX`、
  `HAM_SESSION_CLEANUP_INTERVAL`、`HAM_SHUTDOWN_TIMEOUT`
- 静态与 HTTP：`HAM_STATIC_DIR`、`HAM_STATIC_MAX_AGE`、`HAM_KEEP_ALIVE_TIMEOUT`、
  `HAM_HEADERS_TIMEOUT`、`HAM_REQUEST_TIMEOUT`
- 视图/上传/请求体：`HAM_VIEW_DIR`、`HAM_VIEW_EXT`、`HAM_TEMP_DIR`、`HAM_ENABLE_XSS`、`HAM_MAX_BODY_SIZE`

`PORT` 不在 `HAM_*` 映射中，仍由 `listen()` 直接读取；`HAM_PORT` 则作为普通配置项
（可被 `config.port` 覆盖）。

```dotenv
# .env
PORT=8080
HAM_DEBUG=true
HAM_LOG_LEVEL=info
HAM_LOG_FORMAT=json
HAM_LOG_REQUESTS=true
HAM_DB_TYPE=mysql
HAM_DB_HOST=127.0.0.1
HAM_DB_PORT=3306
HAM_SESSION_MAX=5000
```

## 内置常量

框架导出了常用常量，避免在业务代码里散落魔法字符串/数字（均从包入口导入）：

| 常量 | 用途 |
| --- | --- |
| `HTTP_STATUS` | 常用状态码，如 `HTTP_STATUS.NOT_FOUND`、`HTTP_STATUS.TOO_MANY_REQUESTS` |
| `CONTENT_TYPE` | `TEXT` / `HTML` / `JSON` / `OCTET_STREAM` |
| `HTTP_HEADER` | `CONTENT_TYPE` / `CONTENT_LENGTH` / `ETAG` / `LOCATION` / `SET_COOKIE` / `REQUEST_ID` 等 |
| `HTTP_METHOD` | `GET` / `POST` / `PUT` / `PATCH` / `HEAD` 等 |
| `MIME_TYPE` | `JSON` / `MULTIPART` / `FORM_URLENCODED` |
| `SECOND_MS` / `MINUTE_MS` | 毫秒时间单位 |
| `DEFAULT_CONTROLLER` / `DEFAULT_ACTION` / `DEFAULT_HOST` | 路由与 URL 解析缺省值 |

```ts
import { HTTP_STATUS, HTTP_HEADER } from 'ham-web-server';

ctx.status(HTTP_STATUS.UNAUTHORIZED);
ctx.echo({ ok: false }, HTTP_STATUS.UNAUTHORIZED);
ctx.setHeader(HTTP_HEADER.CACHE_CONTROL, 'no-store');
```

示例应用把 DI 令牌、会话键、表名、分页/限流参数、订单状态等领域常量分别放在
`src/examples/*/constants.ts`，控制器/服务/守卫共用同一份定义。

## 从 1.x 迁移

| 1.x | 2.0 |
| --- | --- |
| 全局 `APP_PATH`/`APP_DEBUG`/`Ham`/`$A` + 40 个全局函数 | 显式 `new HamApplication()`，工具函数具名导入 |
| `APP_PATH/ham/controller/*.js` | `controllers/`（`@Controller` 注册） |
| `APP_PATH/ham/view/*.html` | `views/` |
| `APP_PATH/ham/conf/config.js` | `new HamApplication({ config })` |
| `Ham.Controller('base', {...})` 继承 | ES 类继承 `extends BaseController` |
| `lib/Class.js` 自制继承 + 原型克隆 | 标准 ES 类（每请求新实例，无共享状态） |
| `sqlValidGet/sqlValidPost` 黑名单过滤 | 参数化查询 + 标识符校验（已移除黑名单函数） |
| dblite（依赖 sqlite3 命令行） | `node:sqlite` / `better-sqlite3` |
| `LokiModel`（未启用，缺依赖） | 已移除 |
| 控制器实例跨请求复用 | 每请求新建，`tplData` 不再串号 |

## 项目结构

```
src/
├── index.ts                 # 公共 API 出口
├── application.ts           # HamApplication：组装容器/路由/请求处理/生命周期
├── cluster.ts               # 内置多进程（runCluster）、PM2 检测与主进程任务判断
├── types.ts                 # HamConfig 等类型与默认配置
├── constants.ts             # HTTP 状态码 / 响应头 / Content-Type / 时间单位等公共常量
├── container/               # IoC 容器与装饰器
├── core/                    # Context / Router / StaticServer / SessionService / SessionStore / body
├── controller/BaseController.ts
├── database/                # Database + QueryBuilder + 驱动
├── cache/LRUCache.ts
├── config/                  # ConfigService + .env/HAM_* 环境变量映射
├── logging/Logger.ts        # pino 日志器、请求/错误日志、脱敏
├── view/ViewEngine.ts
├── utils/                   # md5 / cookie / 日期格式化等
├── examples/demo/           # 演示应用（npm run demo）
├── examples/message-board/  # 留言板（npm run board）：用户系统 + 管理员 + 拦截器 + 守卫
├── examples/dinner/         # 点餐系统（npm run dinner）：会话购物车 + 事务下单 + 状态机
└── test/                    # 单元 + 端到端测试（node:test）
```

原 1.x JavaScript 源码保留在 [`legacy/`](legacy) 目录以供对照。

## License

MIT
