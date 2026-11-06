// ab (ApacheBench) 压测脚本：启动留言板服务，依次运行多组压测并汇总 RPS。
//
// 用法：
//   npm run bench                     # ab 取自环境变量 AB 或 PATH 中的 ab
//   AB=/usr/bin/ab node scripts/bench.js   （Linux/WSL）
//   WSL 下：wsl -d Ubuntu-24.04 -- ab ... 由本脚本自动处理（BOARD_HOST 指向网关 IP）
//
// 环境变量：
//   AB          ab 可执行文件（默认 "ab"）
//   BOARD_PORT  服务端口（默认 4320）
//   BOARD_HOST  绑定/访问主机（默认 127.0.0.1；WSL 中压测 Windows 服务时传网关 IP）
//   WSL         设为 "1" 时表示从 WSL 内直接运行本脚本（不再跨系统调 wsl.exe）
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.BOARD_PORT || '4320';
const IN_WSL = process.env.WSL === '1' || (os.platform() !== 'win32');
const HOST = process.env.BOARD_HOST || '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const N = process.env.BENCH_N || '2000';

function wslGateway() {
  try {
    const out = execFileSync('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'ip', 'route', 'show', 'default'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const m = out.match(/default via ([\d.]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function detectAb() {
  const explicit = process.env.AB;
  if (explicit) return { cmd: explicit, wsl: false };
  if (!IN_WSL) {
    // Windows：优先用 WSL 中的 ab，自动取网关 IP 作为目标主机
    try {
      execFileSync('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'which', 'ab'], { stdio: 'pipe' });
      return { wsl: true, cmd: 'ab', gateway: wslGateway() };
    } catch { /* 不可用 */ }
    throw new Error('未找到 ab。可安装 Apache（含 ab.exe）或在 WSL 中 apt install apache2-utils');
  }
  return { cmd: 'ab', wsl: false };
}

/** Windows 路径 -> WSL 内可访问路径 */
function toWslPath(winPath) {
  return winPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
}

function runAb(abSpec, args) {
  const full = abSpec.wsl
    ? ['wsl.exe', '-d', 'Ubuntu-24.04', '--', abSpec.cmd, ...args]
    : [abSpec, ...args];
  const [cmd, ...rest] = full;
  const out = execFileSync(cmd, rest, {
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 16 * 1024 * 1024,
  }).toString('utf8');

  const grab = (re) => (out.match(re) || [])[1];
  const brk = (out.match(/\(Connect: (\d+), Receive: (\d+), Length: (\d+), Exceptions: (\d+)\)/) || [])[0] || '';
  return {
    raw: out,
    rps: Number(grab(/Requests per second:\s+([\d.]+)/)),
    timePerReqMean: Number(grab(/Time per request:\s+([\d.]+)\s+\[ms\]\s+\(mean\)/)),
    timePerReqAll: grab(/Time per request:\s+([\d.]+ \(mean, across all concurrent requests\))/),
    failed: Number(grab(/Failed requests:\s+(\d+)/)),
    // ab 的 Length 计数 = 响应体长度与首个响应不同（如自增 id 位数变化），并非服务器错误
    lengthOnly: /Length: (\d+)/.test(brk) && Number(brk.match(/Length: (\d+)/)[1]) === Number(grab(/Failed requests:\s+(\d+)/)),
    complete: Number(grab(/Complete requests:\s+(\d+)/)),
    p50: Number(grab(/50%\s+(\d+)/)),
    p90: Number(grab(/90%\s+(\d+)/)),
    p99: Number(grab(/99%\s+(\d+)/)),
    transferRate: grab(/Transfer rate:\s+([\d.]+)/),
  };
}

async function waitForServer(child, base, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error('服务进程提前退出:\n' + lastLogs.join('\n'));
    try {
      const r = await fetch(`${base}/board/api?size=1`);
      if (r.ok) return;
    } catch { /* 重试 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('等待服务启动超时');
}

const lastLogs = [];

/**
 * 确保 bench 用户存在并返回其会话 Cookie（留言接口需登录；首个注册者为管理员，不受限流）。
 * 先尝试登录（bench 重复运行时用户已存在），失败则注册。
 */
async function ensureBenchUser(base) {
  const form = (fields) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  const USER = { username: 'benchadmin', password: 'bench123456' };

  const login = await fetch(`${base}/board/login`, form(USER));
  if ((login.headers.get('location') || '') === '/board/') {
    return (login.headers.get('set-cookie') || '').split(';')[0];
  }
  const reg = await fetch(`${base}/board/register`, form({ ...USER, confirm: USER.password }));
  if ((reg.headers.get('location') || '') !== '/board/') {
    throw new Error('注册 bench 用户失败: ' + reg.headers.get('location'));
  }
  return (reg.headers.get('set-cookie') || '').split(';')[0];
}

async function main() {
  const abSpec = detectAb();
  if (abSpec.wsl && !process.env.BOARD_HOST && abSpec.gateway) {
    // WSL2 中 ab 访问 Windows 宿主机服务必须走网关 IP
    process.env.BOARD_HOST = abSpec.gateway;
  }
  const host = process.env.BOARD_HOST || '127.0.0.1';
  const base = `http://${host}:${PORT}`;
  console.log(`ab: ${abSpec.wsl ? `WSL Ubuntu-24.04 中的 ab（目标宿主机 ${host}）` : abSpec.cmd}`);
  console.log(`目标: ${base}/board/`);

  const dataDir = path.resolve(__dirname, '../data');
  // 压测前清理旧数据，保证每次结果可比
  fs.rmSync(path.join(dataDir, 'message-board.sqlite'), { force: true });

  const child = spawn(process.execPath, ['dist/examples/message-board/main.js'], {
    env: { ...process.env, PORT: PORT, HAM_LOG_REQUESTS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { lastLogs.push(String(d).trim()); if (lastLogs.length > 10) lastLogs.shift(); });
  child.stderr.on('data', (d) => { lastLogs.push(String(d).trim()); if (lastLogs.length > 10) lastLogs.shift(); });

  try {
    await waitForServer(child, base);

    // 留言接口需要登录态；首个注册者自动成为管理员，POST 压测不受限流影响
    const benchCookie = await ensureBenchUser(base);
    if (!benchCookie) throw new Error('未取得 bench 用户会话 Cookie');
    console.log('bench 用户已登录（管理员，留言接口免限流）\n');

    // 预热（编译模板、建立缓存）
    for (let i = 0; i < 30; i++) await fetch(`${base}/board/`);
    console.log('预热完成，开始压测…\n');

    // POST 数据文件需放在 ab 进程可读的位置（WSL 时转成 /mnt/... 路径）
    const postFileWin = path.join(dataDir, 'ab-post.json');
    fs.writeFileSync(postFileWin, JSON.stringify({ nickname: 'ab', content: 'ApacheBench 压测留言' }));
    const postFile = abSpec.wsl ? toWslPath(postFileWin) : postFileWin;

    const cases = [
      { name: '留言板首页 HTML   /board/        c=50 ', args: ['-n', N, '-c', '50', `${base}/board/`] },
      { name: 'JSON 分页接口     /board/api     c=50 ', args: ['-n', N, '-c', '50', `${base}/board/api`] },
      { name: 'JSON 分页接口     /board/api     c=10 ', args: ['-n', N, '-c', '10', `${base}/board/api`] },
      { name: 'JSON 分页接口     /board/api     c=100', args: ['-n', N, '-c', '100', `${base}/board/api`] },
      { name: 'JSON 接口 keepalive c=50', args: ['-n', N, '-c', '50', '-k', `${base}/board/api`] },
      { name: '发表留言 POST     /board/apiAdd  c=20 ', args: ['-n', '500', '-c', '20', '-p', postFile, '-T', 'application/json', '-C', benchCookie, `${base}/board/apiAdd`] },
    ];

    const results = [];
    for (const c of cases) {
      process.stdout.write(`>> ${c.name} ... `);
      let r;
      try {
        r = runAb(abSpec, c.args);
      } catch (e) {
        console.log('ab 运行失败');
        console.error(String(e.stderr || e));
        continue;
      }
      results.push({ name: c.name, ...r });
      console.log(`RPS=${r.rps}  失败=${r.failed}`);
      // 写入压测后清理新增留言，避免数据膨胀影响后续用例
      try { fs.rmSync(path.join(dataDir, 'message-board.sqlite'), { force: true }); } catch { /* 忽略 */ }
      await new Promise((r2) => setTimeout(r2, 300));
    }
    fs.rmSync(postFileWin, { force: true });

    console.log('\n================ 压测结果汇总 ================');
    console.log('用例'.padEnd(42) + 'RPS'.padStart(9) + '  均值延迟(ms)'.padStart(14) + '   p99(ms)'.padStart(9) + '   失败'.padStart(6));
    for (const r of results) {
      const failText = r.failed === 0 ? '0' : ` ${r.failed}${r.lengthOnly ? ' (均为ab的Length计数，非真实错误)' : ''}`;
      console.log(
        r.name.padEnd(42) +
        String(r.rps).padStart(9) +
        String(r.timePerReqMean).padStart(14) +
        String(r.p99).padStart(9) +
        failText,
      );
    }
    console.log('=============================================');
    console.log(`说明: ab ${abSpec.wsl ? '运行于 WSL2，经 NAT 网关访问 Windows 宿主机' : '与服务器同机'}；Node 单进程 + SQLite (node:sqlite)。`);
  } finally {
    child.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
