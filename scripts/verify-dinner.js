// 点餐系统功能验证：菜单 / 会话购物车 / 事务下单 / 取餐号 / 状态机 / 类级守卫 / 菜品管理
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PORT = process.env.DINNER_PORT || 4321;
const HOST = process.env.DINNER_HOST || '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const DB_FILE = path.resolve(__dirname, '../data/dinner.sqlite');
const ADMIN_PASSWORD = process.env.DINNER_ADMIN_PASSWORD || 'admin123';

// 种子菜品（价格单位：分）
const P_SHRZ = 2880; // 红烧狮子头 id=1
const P_YZCF = 1580; // 扬州炒饭   id=4

function form(fields, cookie) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  };
}

function cookieOf(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

/** 打开只读数据库连接做落库校验（服务端同时持有连接，SQLite 允许多连接） */
function openDb() {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(DB_FILE);
}

async function main() {
  for (const f of [DB_FILE, `${DB_FILE}-shm`, `${DB_FILE}-wal`]) {
    fs.rmSync(f, { force: true });
  }

  const child = spawn(process.execPath, ['dist/examples/dinner/main.js'], {
    env: { ...process.env, PORT: String(PORT), HAM_LOG_REQUESTS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  try {
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        ready = (await fetch(`${BASE}/dinner/`)).ok;
      } catch { /* 重试 */ }
    }
    assert.ok(ready, '服务未能启动');
    console.log(`服务已启动: ${BASE}/dinner/`);

    // ================= A. 菜单与购物车（无需登录） =================
    const r1 = await fetch(`${BASE}/dinner/`);
    const b1 = await r1.text();
    assert.strictEqual(r1.status, 200);
    assert.ok(b1.includes('阿福小馆'), '首页标题');
    assert.ok(b1.includes('招牌菜') && b1.includes('主食') && b1.includes('小吃饮品') && b1.includes('甜品'), '菜单按 4 个分类分组');
    assert.ok(b1.includes('红烧狮子头'), '包含种子菜品');
    assert.ok(b1.includes('加入购物车'), '每道菜有加购按钮');
    assert.ok(b1.includes('购物车 (0)'), '初始购物车为空');
    assert.ok(r1.headers.get('x-request-id'), '响应带 X-Request-Id（框架统一生成）');
    console.log('A1  GET  /dinner/            -> 200 菜单 4 分类 + 种子菜品 + Request-Id ✓');

    const css = await fetch(`${BASE}/static/dinner.css`);
    assert.strictEqual(css.status, 200, '静态资源可访问');
    assert.ok((await css.text()).includes('.status-tag'), '样式文件内容正确');
    console.log('A2  GET  /static/dinner.css  -> 200 静态资源 ✓');

    const r3 = await fetch(`${BASE}/dinner/cartAdd`, form({ dishId: 1 }));
    assert.strictEqual(r3.status, 302);
    const addLoc = r3.headers.get('location') || '';
    assert.ok(addLoc.startsWith('/dinner/?added='), `加购后留在菜单页，实际 ${addLoc}`);
    assert.ok(addLoc.endsWith('#dish-1'), '带锚点回到该菜品');
    const guestCookie = cookieOf(r3);
    assert.ok(guestCookie, '服务端会话下发 Cookie');
    const a3t = await (await fetch(`${BASE}${addLoc.split('#')[0]}`, { headers: { cookie: guestCookie } })).text();
    assert.ok(a3t.includes('已加入购物车'), '菜单页显示加购提示');
    assert.ok(a3t.includes('购物车 (1)'), '菜单页角标即时更新');
    console.log('A3  POST /dinner/cartAdd     -> 302 留在菜单页 + 提示 + 角标 1 ✓');

    const r4 = await fetch(`${BASE}/dinner/cart`, { headers: { cookie: guestCookie } });
    const b4 = await r4.text();
    assert.strictEqual(r4.status, 200);
    assert.ok(b4.includes('红烧狮子头'), '购物车含所选菜品');
    assert.ok(b4.includes('¥28.80'), '单价按元格式化');
    assert.ok(b4.includes('合计：<b>¥28.80</b>'), '合计金额正确');
    console.log('A4  GET  /dinner/cart        -> 200 含菜品 + 合计 ¥28.80 ✓');

    const r5add = await fetch(`${BASE}/dinner/cartAdd`, form({ dishId: 4 }, guestCookie));
    assert.strictEqual(r5add.status, 302);
    assert.ok((r5add.headers.get('location') || '').endsWith('#dish-4'), '第二次加购同样留在菜单页');
    const r5 = await fetch(`${BASE}/dinner/cart`, { headers: { cookie: guestCookie } });
    const b5 = await r5.text();
    assert.ok(b5.includes('扬州炒饭'), '第二道菜已加入');
    const t5 = P_SHRZ + P_YZCF;
    assert.ok(b5.includes(`合计：<b>¥${(t5 / 100).toFixed(2)}</b>`), `两道菜合计 ${(t5 / 100).toFixed(2)}`);
    console.log(`A5  POST /dinner/cartAdd x2  -> 200 两菜合计 ¥${(t5 / 100).toFixed(2)} ✓`);

    const r6 = await fetch(`${BASE}/dinner/cartUpdate`, form({ dishId: 1, qty: 2 }, guestCookie));
    assert.strictEqual(r6.status, 302);
    const b6 = await (await fetch(`${BASE}/dinner/cart`, { headers: { cookie: guestCookie } })).text();
    assert.ok(b6.includes('¥57.60'), '数量改 2 后小计 ¥57.60');
    const t6 = P_SHRZ * 2 + P_YZCF;
    assert.ok(b6.includes(`合计：<b>¥${(t6 / 100).toFixed(2)}</b>`), '合计随数量更新');
    console.log(`A6  POST /dinner/cartUpdate  -> 302 qty=2 小计 ¥57.60 合计 ¥${(t6 / 100).toFixed(2)} ✓`);

    const mn = await (await fetch(`${BASE}/dinner/`, { headers: { cookie: guestCookie } })).text();
    assert.ok(mn.includes('购物车 (3)'), '菜单页显示购物车件数 3');
    console.log('A7  GET  /dinner/(已加购)    -> 购物车角标 3 ✓');

    const r8 = await fetch(`${BASE}/dinner/cartAdd`, form({ dishId: 9999 }, guestCookie));
    assert.strictEqual(r8.status, 302);
    assert.ok((r8.headers.get('location') || '').startsWith('/dinner/?error='), '不存在的菜品被拒');
    console.log('A8  POST /dinner/cartAdd(9999)-> 302 错误提示（菜品校验）✓');

    // ================= B. 管理后台守卫 + 登录 =================
    const g1 = await fetch(`${BASE}/dinner-admin/`, { redirect: 'manual' });
    assert.strictEqual(g1.status, 302);
    assert.strictEqual(g1.headers.get('location'), '/dinner-admin/login', '类级守卫拦截');
    const g2 = await fetch(`${BASE}/dinner-admin/dishes`, { redirect: 'manual' });
    assert.strictEqual(g2.status, 302, '类级守卫覆盖全部动作');
    console.log('B1  GET  /dinner-admin/      -> 302 登录页（类级 @UseGuards）✓');

    const g3 = await fetch(`${BASE}/dinner-admin/login`, { redirect: 'manual' });
    assert.strictEqual(g3.status, 200, 'login 动作被守卫豁免，不会死循环');
    assert.ok((await g3.text()).includes('店主登录'));
    console.log('B2  GET  /dinner-admin/login -> 200 登录页（守卫豁免 login）✓');

    const g4 = await fetch(`${BASE}/dinner-admin/login`, form({ password: 'wrong-pass' }));
    assert.strictEqual(g4.status, 302);
    assert.ok((g4.headers.get('location') || '').includes('error='), '错口令被拒');
    console.log('B3  POST /dinner-admin/login -> 302 口令错误提示 ✓');

    const g5 = await fetch(`${BASE}/dinner-admin/login`, form({ password: ADMIN_PASSWORD }));
    assert.strictEqual(g5.status, 302);
    assert.strictEqual(g5.headers.get('location'), '/dinner-admin/');
    const adminCookie = cookieOf(g5);
    assert.ok(adminCookie, '管理员会话');
    const g6 = await (await fetch(`${BASE}/dinner-admin/`, { headers: { cookie: adminCookie } })).text();
    assert.ok(g6.includes('订单管理'), '进入后台');
    assert.ok(g6.includes('还没有订单'), '暂无订单');
    console.log('B4  POST /dinner-admin/login -> 302 登录成功 + 空订单列表 ✓');

    // ================= C. 下单（事务 + 服务端计价 + 取餐号） =================
    const o1 = await fetch(`${BASE}/dinner/orderSubmit`, form({
      customer: '张同学', tableNo: '8',
    }, guestCookie));
    assert.strictEqual(o1.status, 302);
    const loc = o1.headers.get('location') || '';
    assert.ok(/^\/dinner\/order\/\d+$/.test(loc), `下单后跳订单页，实际 ${loc}`);
    const orderId = Number(loc.split('/').pop());
    console.log(`C1  POST /dinner/orderSubmit  -> 302 ${loc} ✓`);

    const o2 = await fetch(`${BASE}${loc}`, { headers: { cookie: guestCookie } });
    const b2 = await o2.text();
    assert.strictEqual(o2.status, 200);
    assert.ok(b2.includes('N1001'), '取餐号 N1001');
    assert.ok(b2.includes('待接单') && b2.includes('status-tag s0'), '初始状态待接单');
    assert.ok(b2.includes('红烧狮子头') && b2.includes('扬州炒饭'), '订单明细含两道菜');
    assert.ok(b2.includes('×2'), '菜品数量快照');
    assert.ok(b2.includes(`应付：<b>¥${(t6 / 100).toFixed(2)}</b>`), '订单总价');
    assert.ok(b2.includes('张同学') && b2.includes('桌号：8'), '称呼与桌号');
    console.log(`C2  GET  ${loc}               -> 200 取餐号 N1001 + 明细 + ¥${(t6 / 100).toFixed(2)} ✓`);

    const o3 = await fetch(`${BASE}/dinner/order?no=N1001`);
    assert.strictEqual(o3.status, 200);
    assert.ok((await o3.text()).includes('N1001'), '按取餐号查单');
    console.log('C3  GET  /dinner/order?no=N1001-> 200 取餐号查单 ✓');

    const o4 = await fetch(`${BASE}/dinner/cart`, { headers: { cookie: guestCookie } });
    assert.ok((await o4.text()).includes('购物车是空的'), '下单后购物车已清空');
    console.log('C4  GET  /dinner/cart(下单后) -> 购物车已清空 ✓');

    const db = openDb();
    const order = db.prepare('SELECT * FROM ham_orders WHERE id = ?').get(orderId);
    assert.ok(order, '订单已落库');
    assert.strictEqual(order.orderNo, 'N1001');
    assert.strictEqual(order.totalPrice, t6, `服务端重新计价 ${t6} 分`);
    assert.strictEqual(order.status, 0);
    assert.strictEqual(order.customer, '张同学');
    assert.strictEqual(order.tableNo, '8');
    const items = db.prepare('SELECT * FROM ham_order_items WHERE orderId = ? ORDER BY id').all(orderId);
    assert.strictEqual(items.length, 2, '明细 2 行');
    assert.strictEqual(items[0].price, P_SHRZ, '明细保存价格快照');
    assert.strictEqual(items[0].quantity, 2);
    assert.strictEqual(items[1].price, P_YZCF);
    console.log('C5  DB 校验                 -> totalPrice=' + order.totalPrice + ' 分，明细 2 行，价格快照 ✓');

    // ================= D. 订单状态机 =================
    const d1 = await (await fetch(`${BASE}/dinner-admin/`, { headers: { cookie: adminCookie } })).text();
    assert.ok(d1.includes('N1001') && d1.includes('>接单<'), '后台可见新单与接单按钮');
    console.log('D1  GET  /dinner-admin/      -> 后台显示 N1001 + 接单按钮 ✓');

    const st = async (to) => fetch(`${BASE}/dinner-admin/orderStatus`, form({ orderId, to }, adminCookie));
    const viewOrder = async () => (await fetch(`${BASE}${loc}`)).text();

    const d2 = await st(1);
    assert.strictEqual(d2.status, 302);
    assert.strictEqual(d2.headers.get('location'), '/dinner-admin/');
    assert.ok((await viewOrder()).includes('制作中'), '0 -> 1 接单成功');
    console.log('D2  POST orderStatus to=1    -> 302 待接单 -> 制作中 ✓');

    const d3 = await st(3);
    assert.strictEqual(d3.status, 302);
    assert.ok((d3.headers.get('location') || '').includes('error='), '制作中不可取消');
    assert.ok((await viewOrder()).includes('制作中'), '非法流转未改状态');
    console.log('D3  POST orderStatus to=3    -> 302 非法流转「制作中 -> 已取消」被拒 ✓');

    const d4 = await st(2);
    assert.strictEqual(d4.status, 302);
    assert.ok((await viewOrder()).includes('已完成'), '1 -> 2 出餐成功');
    console.log('D4  POST orderStatus to=2    -> 302 制作中 -> 已完成 ✓');

    const d5 = await st(1);
    assert.ok((d5.headers.get('location') || '').includes('error='), '已完成不可回退');
    const d5db = db.prepare('SELECT status FROM ham_orders WHERE id = ?').get(orderId);
    assert.strictEqual(d5db.status, 2, '状态仍为已完成');
    console.log('D5  POST orderStatus to=1    -> 302 已完成不可回退 ✓');

    // ================= E. 菜品管理（增/改/上下架/删） =================
    const e1 = await (await fetch(`${BASE}/dinner-admin/dishes`, { headers: { cookie: adminCookie } })).text();
    assert.ok(e1.includes('菜品管理') && e1.includes('红烧狮子头') && e1.includes('在售'), '菜品列表');
    console.log('E1  GET  /dinner-admin/dishes-> 200 菜品列表 + 在售状态 ✓');

    const e2 = await fetch(`${BASE}/dinner-admin/dishSave`, form({
      id: 0, name: '测试小菜', category: '小吃饮品', priceYuan: '12.5', description: '自动验证用',
    }, adminCookie));
    assert.strictEqual(e2.status, 302);
    assert.strictEqual(e2.headers.get('location'), '/dinner-admin/dishes');
    const e2t = await (await fetch(`${BASE}/dinner-admin/dishes`, { headers: { cookie: adminCookie } })).text();
    assert.ok(e2t.includes('测试小菜') && e2t.includes('¥12.50'), '新菜品入列表，元输入转分展示');
    const newDish = db.prepare('SELECT * FROM ham_dishes WHERE name = ?').get('测试小菜');
    assert.strictEqual(newDish.price, 1250, '12.5 元 -> 1250 分');
    assert.strictEqual(newDish.isAvailable, 1);
    console.log('E2  POST dishSave(新增)      -> 302 新增「测试小菜」¥12.50（1250 分）✓');

    assert.ok((await (await fetch(`${BASE}/dinner/`)).text()).includes('测试小菜'), '菜单页可见新菜');
    console.log('E3  GET  /dinner/            -> 菜单页出现新菜 ✓');

    await fetch(`${BASE}/dinner-admin/dishToggle`, form({ id: newDish.id }, adminCookie));
    const e4t = await (await fetch(`${BASE}/dinner-admin/dishes`, { headers: { cookie: adminCookie } })).text();
    assert.ok(e4t.includes('已下架'), '后台显示已下架');
    assert.strictEqual(db.prepare('SELECT isAvailable FROM ham_dishes WHERE id = ?').get(newDish.id).isAvailable, 0);
    assert.ok(!(await (await fetch(`${BASE}/dinner/`)).text()).includes('测试小菜'), '下架后菜单页消失');
    console.log('E4  POST dishToggle          -> 302 下架：后台标记已下架、菜单页消失 ✓');

    const e5 = await fetch(`${BASE}/dinner-admin/dishSave`, form({
      id: newDish.id, name: '测试小菜（改）', category: '主食', priceYuan: '15', description: '改价',
    }, adminCookie));
    assert.strictEqual(e5.status, 302);
    assert.strictEqual(db.prepare('SELECT price FROM ham_dishes WHERE id = ?').get(newDish.id).price, 1500);
    assert.ok((await (await fetch(`${BASE}/dinner-admin/dishes`, { headers: { cookie: adminCookie } })).text())
      .includes('测试小菜（改）'), '编辑生效');
    console.log('E5  POST dishSave(编辑)      -> 302 改名改价 15 元 -> 1500 分 ✓');

    const e6 = await fetch(`${BASE}/dinner-admin/dishSave`, form({
      id: 0, name: '', category: '', priceYuan: '10', description: '',
    }, adminCookie));
    assert.ok((e6.headers.get('location') || '').includes('error='), '空名称被拒');
    const e7 = await fetch(`${BASE}/dinner-admin/dishSave`, form({
      id: 0, name: '零元菜', category: '', priceYuan: '0', description: '',
    }, adminCookie));
    assert.ok((e7.headers.get('location') || '').includes('error='), '非正价格被拒');
    console.log('E6  POST dishSave(非法)      -> 302 空名称/零价格被拒 ✓');

    await fetch(`${BASE}/dinner-admin/dishDelete`, form({ id: newDish.id }, adminCookie));
    assert.ok(!(await (await fetch(`${BASE}/dinner-admin/dishes`, { headers: { cookie: adminCookie } }))
      .text()).includes('测试小菜'), '删除生效');
    assert.strictEqual(db.prepare('SELECT * FROM ham_dishes WHERE id = ?').get(newDish.id), undefined);
    console.log('E7  POST dishDelete          -> 302 菜品已删除 ✓');

    // ================= F. 边界 =================
    const f1 = await fetch(`${BASE}/dinner/orderSubmit`, form({ customer: '空车', tableNo: '' }));
    assert.strictEqual(f1.status, 302);
    assert.ok((f1.headers.get('location') || '').includes('/dinner/cart?error='), '空购物车下单被拒');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM ham_orders').get().n, 1, '没有产生脏订单');
    console.log('F1  POST orderSubmit(空车)   -> 302 错误提示，无脏订单 ✓');

    const f2 = await fetch(`${BASE}/dinner/order?no=N9999`);
    assert.strictEqual(f2.status, 404, '不存在的取餐号 404');
    const f3 = await fetch(`${BASE}/dinner/order/999`);
    assert.strictEqual(f3.status, 404, '不存在的订单 id 404');
    console.log('F2  GET  /dinner/order(无效) -> 404 取餐号/订单号不存在 ✓');

    const f4 = await fetch(`${BASE}/dinner-admin/logout`, { headers: { cookie: adminCookie }, redirect: 'manual' });
    assert.strictEqual(f4.status, 302);
    const f5 = await fetch(`${BASE}/dinner-admin/`, { headers: { cookie: adminCookie }, redirect: 'manual' });
    assert.strictEqual(f5.status, 302, '登出后守卫重新拦截');
    console.log('F3  GET  /dinner-admin/logout -> 302 登出后守卫重新拦截 ✓');

    db.close();
    console.log('\n=== 点餐系统功能验证全部通过 ===');
  } finally {
    child.kill();
  }
  if (process.env.SHOW_LOG && log) {
    console.log('--- 服务器日志 ---\n' + log.split('\n').slice(0, 10).join('\n'));
  }
}

main().catch((e) => {
  console.error('验证失败:', e);
  process.exit(1);
});
