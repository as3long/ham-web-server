// 留言板功能验证：用户系统（注册/登录/改密）+ 管理员权限 + 守卫 + 拦截器 全流程
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PORT = process.env.BOARD_PORT || 4320;
const HOST = process.env.BOARD_HOST || '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
// 第一个注册的自动成为管理员
const ADMIN = { username: '站长老王', password: 'admin123456' };
const USER2 = { username: '普通小明', password: 'user12345678' };

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

async function main() {
  // 压测残留会让种子数据不在第一页，先清理数据库保证断言确定性
  fs.rmSync(path.resolve(__dirname, '../data/message-board.sqlite'), { force: true });

  const child = spawn(process.execPath, ['dist/examples/message-board/main.js'], {
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
        const r = await fetch(`${BASE}/board/api?size=1`);
        ready = r.ok;
      } catch { /* 重试 */ }
    }
    assert.ok(ready, '服务未能启动');
    console.log(`服务已启动: ${BASE}/board/`);

    // ================= A. 未登录 =================
    const r1 = await fetch(`${BASE}/board/`);
    const b1 = await r1.text();
    assert.strictEqual(r1.status, 200);
    assert.ok(b1.includes('留言板'));
    assert.ok(b1.includes('/board/login') && b1.includes('/board/register'), '未登录显示登录/注册入口');
    assert.ok(!b1.includes('action="/board/add"'), '未登录不显示留言表单');
    assert.ok(b1.includes('登录后才能发表留言'), '未登录表单区显示提示');
    assert.ok(/共 \d+ 条留言/.test(b1), '包含留言总数');
    assert.ok(b1.includes('铁柱') || b1.includes('老王'), '包含种子数据');
    assert.ok(r1.headers.get('x-request-id'), '响应带 X-Request-Id（框架统一生成）');
    console.log('A1  GET  /board/           -> 200 未登录只读视图 ✓');

    const a2 = await fetch(`${BASE}/board/add`, form({ nickname: '路人', content: '未登录尝试' }));
    assert.strictEqual(a2.status, 302);
    assert.strictEqual(a2.headers.get('location'), '/board/login');
    console.log('A2  POST /board/add         -> 302 登录页 (FormLoginGuard) ✓');

    const a3 = await fetch(`${BASE}/board/apiAdd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname: '路人', content: '未登录尝试' }),
    });
    assert.strictEqual(a3.status, 401);
    assert.strictEqual((await a3.json()).ok, false);
    console.log('A3  POST /board/apiAdd      -> 401 (ApiLoginGuard) ✓');

    const a4 = await fetch(`${BASE}/board/adminDelete?id=1`, { method: 'POST', redirect: 'manual' });
    assert.strictEqual(a4.status, 302);
    assert.strictEqual(a4.headers.get('location'), '/board/login');
    console.log('A4  POST /board/adminDelete -> 302 登录页 (AdminGuard 未登录) ✓');

    const a5 = await fetch(
      `${BASE}/board/api?page=1&x=${encodeURIComponent('<script>alert(1)</script>')}`,
    );
    assert.strictEqual(a5.status, 403, 'query 注入尝试 -> 全局守卫 403');
    console.log('A5  GET  /board/api?x=<script> -> 403 (全局函数式守卫) ✓');

    // ================= B. 注册管理员（第一个用户） =================
    const b0 = await fetch(`${BASE}/board/register`);
    assert.strictEqual(b0.status, 200);
    console.log('B0  GET  /board/register    -> 200 注册页 ✓');

    const e1 = await fetch(`${BASE}/board/register`, form({
      username: ADMIN.username, password: '1', confirm: '2',
    }));
    assert.strictEqual(e1.status, 302);
    assert.ok((e1.headers.get('location') || '').includes('error='), '两次密码不一致被拦');
    console.log('B1  POST /board/register    -> 302 密码不一致提示 ✓');

    const e2 = await fetch(`${BASE}/board/register`, form({
      username: ADMIN.username, password: '123', confirm: '123',
    }));
    assert.strictEqual(e2.status, 302);
    assert.ok((e2.headers.get('location') || '').includes('error='), '过短密码被拦');
    console.log('B2  POST /board/register    -> 302 密码过短提示 ✓');

    const b3 = await fetch(`${BASE}/board/register`, form({
      username: ADMIN.username, password: ADMIN.password, confirm: ADMIN.password,
    }));
    assert.strictEqual(b3.status, 302);
    assert.strictEqual(b3.headers.get('location'), '/board/', '注册成功自动登录');
    const adminCookie = cookieOf(b3);
    assert.ok(adminCookie, '拿到会话 Cookie');
    console.log('B3  POST /board/register    -> 302 注册成功并自动登录 ✓');

    const b4 = await fetch(`${BASE}/board/`, { headers: { cookie: adminCookie } });
    const b4t = await b4.text();
    assert.ok(b4t.includes('欢迎'), '登录态欢迎语');
    assert.ok(b4t.includes(ADMIN.username), '欢迎语含用户名');
    assert.ok(b4t.includes('管理员'), '首个注册用户自动成为管理员');
    assert.ok(b4t.includes('action="/board/add"'), '登录后显示留言表单');
    console.log('B4  GET  /board/(管理员)     -> 欢迎语 + 管理员徽标 + 表单 ✓');

    const b5 = await fetch(`${BASE}/board/add`, form({ content: '管理员的第一条留言' }, adminCookie));
    assert.strictEqual(b5.status, 302);
    assert.strictEqual(b5.headers.get('location'), '/board/?posted=1');
    const b5t = await (await fetch(`${BASE}/board/`, { headers: { cookie: adminCookie } })).text();
    assert.ok(b5t.includes(ADMIN.username), '留言昵称固定为登录账号');
    assert.ok(
      b5t.includes(`<b class="nick">${ADMIN.username}</b><i class="badge">管理员</i>`),
      '管理员发布的留言带管理员徽标',
    );
    assert.ok(b5t.includes('IP:'), '管理员视角显示留言者 IP');
    console.log('B5  POST /board/add(管理员)  -> 302 留言带管理员徽标 + 管理员可见 IP ✓');

    const b6 = await fetch(`${BASE}/board/apiAdd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ content: 'JSON 接口发的留言（待删除）' }),
    });
    const b6j = await b6.json();
    assert.strictEqual(b6.status, 200);
    assert.ok(b6j.ok && b6j.id > 0);
    console.log(`B6  POST /board/apiAdd      -> 200 id=${b6j.id} ✓`);

    const b7 = await fetch(`${BASE}/board/apiAdd`, form({ content: '表单打 JSON 接口' }, adminCookie));
    assert.strictEqual(b7.status, 415, '登录态下非 JSON 请求体 -> 415');
    console.log('B7  POST /board/apiAdd(表单) -> 415 (JsonOnlyInterceptor) ✓');

    const b8 = await fetch(`${BASE}/board/adminDelete?id=${b6j.id}`, {
      method: 'POST', headers: { cookie: adminCookie }, redirect: 'manual',
    });
    assert.strictEqual(b8.status, 302, '管理员删除留言');
    const b8j = await (await fetch(`${BASE}/board/api?size=50&page=1`)).json();
    assert.ok(!b8j.list.some((m) => m.id === b6j.id), '留言已被删除');
    console.log(`B8  POST /board/adminDelete -> 302 管理员删除 id=${b6j.id} ✓`);

    // ================= C. 普通用户 =================
    const c0 = await fetch(`${BASE}/board/logout`, { headers: { cookie: adminCookie }, redirect: 'manual' });
    assert.strictEqual(c0.status, 302);
    const c0t = await (await fetch(`${BASE}/board/`, { headers: { cookie: adminCookie } })).text();
    assert.ok(!c0t.includes('欢迎'), '登出后回到未登录态');
    console.log('C0  GET  /board/logout      -> 302 登出生效 ✓');

    const c1 = await fetch(`${BASE}/board/login`, form({
      username: ADMIN.username, password: 'wrong-password',
    }));
    assert.strictEqual(c1.status, 302);
    assert.ok((c1.headers.get('location') || '').includes('error='), '错误密码被拦');
    console.log('C1  POST /board/login       -> 302 错误密码提示 ✓');

    const c2 = await fetch(`${BASE}/board/register`, form({
      username: USER2.username, password: USER2.password, confirm: USER2.password,
    }));
    assert.strictEqual(c2.status, 302);
    assert.strictEqual(c2.headers.get('location'), '/board/', '第二个用户注册即登录');
    const user2Cookie = cookieOf(c2);
    const c2t = await (await fetch(`${BASE}/board/`, { headers: { cookie: user2Cookie } })).text();
    assert.ok(c2t.includes(USER2.username), '欢迎语切换为新用户');
    assert.ok(!c2t.includes(`${USER2.username}</b><i class="badge"`), '第二个用户没有管理员徽标');
    console.log('C2  POST /board/register    -> 302 普通用户注册成功 ✓');

    const c3 = await fetch(`${BASE}/board/adminDelete?id=2`, {
      method: 'POST', headers: { cookie: user2Cookie }, redirect: 'manual',
    });
    assert.strictEqual(c3.status, 403, '非管理员删除 -> AdminGuard 403');
    console.log('C3  POST /board/adminDelete -> 403 非管理员被拒 ✓');

    const c4 = await fetch(`${BASE}/board/add`, form({
      content: '普通用户的留言 <b>加粗</b><script>alert(1)</script>',
    }, user2Cookie));
    assert.strictEqual(c4.status, 302);
    assert.strictEqual(c4.headers.get('location'), '/board/?posted=1');
    const c4t = await (await fetch(`${BASE}/board/`, { headers: { cookie: user2Cookie } })).text();
    assert.ok(c4t.includes(USER2.username), '留言已显示');
    assert.ok(!c4t.includes('<script>'), 'script 已被处理');
    assert.ok(!c4t.includes('IP:'), '普通用户视角不显示 IP');
    assert.ok(
      !c4t.includes(`${USER2.username}</b><i class="badge"`),
      '普通用户发布的留言不带徽标',
    );
    console.log('C4  POST /board/add(普通用户)-> 302 发表成功（无徽标/不可见 IP）✓');

    // 改密：旧密码错 -> 成功 -> 新密码可登录
    const c5 = await fetch(`${BASE}/board/password`, form({
      oldPassword: 'wrong-old', newPassword: 'new987654', confirm: 'new987654',
    }, user2Cookie));
    assert.strictEqual(c5.status, 302);
    assert.ok((c5.headers.get('location') || '').includes('error='), '旧密码错误被拦');
    console.log('C5  POST /board/password    -> 302 旧密码错误提示 ✓');

    const c6 = await fetch(`${BASE}/board/password`, form({
      oldPassword: USER2.password, newPassword: 'new987654', confirm: 'new987654',
    }, user2Cookie));
    assert.strictEqual(c6.status, 302);
    assert.strictEqual(c6.headers.get('location'), '/board/?passwordChanged=1');
    console.log('C6  POST /board/password    -> 302 修改成功 ✓');

    await fetch(`${BASE}/board/logout`, { headers: { cookie: user2Cookie }, redirect: 'manual' });
    const c7 = await fetch(`${BASE}/board/login`, form({
      username: USER2.username, password: USER2.password,
    }));
    assert.strictEqual(c7.status, 302);
    assert.ok((c7.headers.get('location') || '').includes('error='), '旧密码已失效');
    const c8 = await fetch(`${BASE}/board/login`, form({
      username: USER2.username, password: 'new987654',
    }));
    assert.strictEqual(c8.status, 302);
    assert.strictEqual(c8.headers.get('location'), '/board/', '新密码登录成功');
    const user2Cookie2 = cookieOf(c8); // 新密码登录后的会话
    console.log('C7  登录: 旧密码失效 / 新密码成功 ✓');

    console.log('\n=== 留言板功能验证全部通过 ===');

    // ================= D. 限流（放最后：连续 POST 占用配额） =================
    let got429 = 0;
    for (let i = 0; i < 12; i++) {
      const p = await fetch(`${BASE}/board/add`, form({ content: `限流测试 ${i}` }, user2Cookie2));
      if (p.status === 429) got429++;
    }
    assert.ok(got429 >= 1, `普通用户连续 12 次 POST 应触发限流，实际 429 次数=${got429}`);
    console.log(`D1  POST /board/add x12(普通)-> 限流 ${got429} 次 429 (RateLimitInterceptor) ✓`);

    let admin429 = 0;
    for (let i = 0; i < 15; i++) {
      const p = await fetch(`${BASE}/board/add`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: adminCookie },
        body: new URLSearchParams({ content: `管理员豁免 ${i}` }).toString(),
        redirect: 'manual',
      });
      if (p.status === 429) admin429++;
      else assert.strictEqual(p.status, 302, `管理员第 ${i + 1} 次 POST 应正常 302`);
    }
    assert.strictEqual(admin429, 0, '管理员不受限流');
    console.log('D2  POST /board/add x15(管理员) -> 全部 302 无 429（管理员豁免限流）✓');
  } finally {
    child.kill();
  }
  if (process.env.SHOW_LOG && log) console.log('--- 服务器日志 ---\n' + log.split('\n').slice(0, 8).join('\n'));
}

main().catch((e) => {
  console.error('验证失败:', e);
  process.exit(1);
});
