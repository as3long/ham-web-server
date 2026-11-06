// 演示站点端到端验证脚本（Node 版，编码可靠）
const { spawn } = require('child_process');
const assert = require('assert');

const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  const child = spawn(process.execPath, ['dist/examples/demo/main.js'], {
    env: { ...process.env, PORT: String(PORT), HAM_LOG_REQUESTS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  try {
    await new Promise((r) => setTimeout(r, 1500));

    // 1. 首页
    const r1 = await fetch(`${BASE}/`);
    const b1 = await r1.text();
    assert.strictEqual(r1.status, 200);
    assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(b1), '首页包含服务器时间');
    console.log('GET  /            -> 200  包含服务器时间 ✓');

    // 2. JSON 接口
    const r2 = await fetch(`${BASE}/index/time`);
    const j2 = await r2.json();
    assert.strictEqual(r2.status, 200);
    assert.ok(j2.now && typeof j2.uptime === 'number');
    console.log(`GET  /index/time  -> 200  ${JSON.stringify(j2)}`);

    // 3. 提交用户（中文 + 表单）
    const post = async (name, email) =>
      fetch(`${BASE}/user/add`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ name, email }).toString(),
        redirect: 'manual',
      });
    const p1 = await post('张三', 'zhang@demo.dev');
    assert.strictEqual(p1.status, 302);
    assert.strictEqual(p1.headers.get('location'), '/user/');
    console.log('POST /user/add    -> 302 -> /user/ ✓');
    await post('李四', 'li@demo.dev');

    // 4. 列表 + 会话
    const r3 = await fetch(`${BASE}/user/`);
    const b3 = await r3.text();
    assert.strictEqual(r3.status, 200);
    assert.ok(b3.includes('张三') && b3.includes('李四'), '列表包含两位用户');
    const cookie = (r3.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie.startsWith('ham_session_id='), '会话 Cookie 已下发');
    const count1 = Number(b3.match(/已访问本页 (\d+) 次/)[1]);
    console.log(`GET  /user/       -> 200  含张三/李四 ✓  首次访问计数=${count1}`);

    // 5. 带会话再次访问
    const r3b = await fetch(`${BASE}/user/`, { headers: { cookie } });
    const b3b = await r3b.text();
    const count2 = Number(b3b.match(/已访问本页 (\d+) 次/)[1]);
    assert.strictEqual(count2, count1 + 1, '会话计数递增');
    console.log(`GET  /user/(带cookie) -> 200  访问计数 ${count1} -> ${count2} ✓`);

    // 6. 路径参数 JSON 接口
    const r4 = await fetch(`${BASE}/user/api/1`);
    const j4 = await r4.json();
    assert.strictEqual(j4.ok, true);
    assert.strictEqual(j4.user.name, '张三');
    console.log(`GET  /user/api/1  -> 200  ${JSON.stringify(j4)}`);

    // 7. 静态资源
    const r5 = await fetch(`${BASE}/static/style.css`);
    const b5 = await r5.text();
    assert.strictEqual(r5.status, 200);
    assert.ok((r5.headers.get('content-type') || '').includes('text/css'));
    console.log(`GET  /static/style.css -> 200  ${r5.headers.get('content-type')} ${b5.length}B ✓`);

    // 8. XSS 过滤
    await post('<script>alert(1)</script>王五', 'w@demo.dev');
    const r6 = await fetch(`${BASE}/user/`);
    const b6 = await r6.text();
    assert.ok(!b6.includes('<script>'), 'script 标签被过滤');
    assert.ok(b6.includes('王五'), '正常中文保留');
    console.log('XSS  过滤         -> <script> 已去除，中文正常 ✓');

    // 9. 404
    const r7 = await fetch(`${BASE}/nosuch/thing`);
    assert.strictEqual(r7.status, 404);
    console.log('GET  /nosuch/thing -> 404 ✓');

    // 10. JSON 请求体
    const r8 = await fetch(`${BASE}/index/time`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(r8.status, 200);
    console.log('POST(JSON) /index/time -> 200 ✓');

    console.log('\n=== 演示站点端到端验证全部通过 ===');
  } finally {
    child.kill();
  }
  if (log) console.log('--- 服务器输出 ---\n' + log.split('\n').slice(0, 6).join('\n'));
}

main().catch((e) => {
  console.error('验证失败:', e);
  process.exit(1);
});
