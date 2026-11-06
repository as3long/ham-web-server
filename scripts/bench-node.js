// Node 版压测脚本：启动留言板服务，用 autocannon 依次压测三类热点，输出 RPS 与延迟分位。
//
// 用法：
//   npm run bench:node                          # 默认 50 并发、10s、预热 3s、每场景重复 3 次
//   npm run bench:node -- --out data/bench-after.json
//   npm run bench:node -- --connections 100 --duration 15
//
// 环境变量：
//   BOARD_PORT  服务端口（默认自动挑选空闲端口）
//   BENCH_N     每场景重复次数（默认 3）
//   BENCH_WARMUP 预热秒数（默认 3）
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const autocannon = require('autocannon');

function parseArgs(argv) {
  const opts = {
    out: null,
    connections: Number(process.env.BENCH_CONNECTIONS) || 50,
    duration: Number(process.env.BENCH_DURATION) || 10,
    warmup: Number(process.env.BENCH_WARMUP) || 3,
    repeat: Number(process.env.BENCH_N) || 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [key, inline] = arg.split('=');
    const value = inline ?? argv[i + 1];
    const take = () => {
      if (inline === undefined) i++;
      return value;
    };
    if (key === '--out') opts.out = take();
    else if (key === '--connections' || key === '-c') opts.connections = Number(take());
    else if (key === '--duration' || key === '-d') opts.duration = Number(take());
    else if (key === '--warmup') opts.warmup = Number(take());
    else if (key === '--repeat') opts.repeat = Number(take());
  }
  return opts;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

const logs = [];

function waitForServer(child, base, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (child.exitCode !== null) {
        reject(new Error('服务进程提前退出:\n' + logs.join('\n')));
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('等待服务启动超时:\n' + logs.join('\n')));
        return;
      }
      try {
        const res = await fetch(`${base}/board/api?size=1`);
        if (res.ok) {
          resolve();
          return;
        }
      } catch {
        /* 继续重试 */
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function runOne(opts, url) {
  return new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        url,
        connections: opts.connections,
        duration: opts.duration,
        pipelining: 1,
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      },
    );
    autocannon.track(instance, { renderProgressBar: false });
  });
}

function summarize(runs) {
  return {
    rps: median(runs.map((r) => r.requests.average)),
    p50: median(runs.map((r) => r.latency.p50)),
    p99: median(runs.map((r) => r.latency.p99)),
    non2xx: runs.reduce((sum, r) => sum + r.non2xx, 0),
    errors: runs.reduce((sum, r) => sum + r.errors, 0),
    timeouts: runs.reduce((sum, r) => sum + r.timeouts, 0),
    runs: runs.map((r) => ({
      rps: r.requests.average,
      p50: r.latency.p50,
      p99: r.latency.p99,
      non2xx: r.non2xx,
      errors: r.errors,
      timeouts: r.timeouts,
    })),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(__dirname, '../data');
  fs.mkdirSync(dataDir, { recursive: true });

  const port = Number(process.env.BOARD_PORT) || (await getFreePort());
  const host = process.env.BOARD_HOST || '127.0.0.1';
  const base = `http://${host}:${port}`;
  const dbFile = path.join(dataDir, `bench-node-${process.pid}.sqlite`);
  const cleanupFiles = [dbFile, `${dbFile}-wal`, `${dbFile}-shm`];

  const child = spawn(process.execPath, ['dist/examples/message-board/main.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      BOARD_DB: dbFile,
      HAM_LOG_REQUESTS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => {
    logs.push(String(d).trim());
    if (logs.length > 10) logs.shift();
  });
  child.stderr.on('data', (d) => {
    logs.push(String(d).trim());
    if (logs.length > 10) logs.shift();
  });

  // Windows 下子进程未完全退出时 SQLite 文件仍被占用，需等 exit 后再删除并重试
  const cleanup = async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    for (const file of cleanupFiles) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(file, { force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    }
  };
  process.once('SIGINT', () => {
    void cleanup().finally(() => process.exit(130));
  });

  try {
    await waitForServer(child, base);
    console.log(`服务已就绪: ${base}`);
    console.log(
      `并发=${opts.connections} 时长=${opts.duration}s 预热=${opts.warmup}s 重复=${opts.repeat}\n`,
    );

    const scenarios = [
      { name: 'JSON 分页接口', path: '/board/api?size=10' },
      { name: '留言板首页', path: '/board/' },
      { name: '静态样式', path: '/static/style.css' },
    ];

    const results = [];
    for (const scenario of scenarios) {
      const url = `${base}${scenario.path}`;
      process.stdout.write(`>> ${scenario.name} (${scenario.path}) 预热 ${opts.warmup}s ... `);
      await runOne({ ...opts, duration: opts.warmup }, url);
      console.log('完成');

      const runs = [];
      for (let i = 0; i < opts.repeat; i++) {
        process.stdout.write(`   第 ${i + 1}/${opts.repeat} 次 ... `);
        const result = await runOne(opts, url);
        runs.push(result);
        console.log(`RPS=${result.requests.average.toFixed(1)} p99=${result.latency.p99}ms`);
      }
      results.push({ name: scenario.name, path: scenario.path, ...summarize(runs) });
      console.log('');
    }

    console.log(
      `================ Node 基准结果（${opts.repeat} 次中位数） ================`,
    );
    console.log(
      '场景'.padEnd(22) + 'RPS'.padStart(10) + 'p50(ms)'.padStart(10) + 'p99(ms)'.padStart(10) +
        '非2xx'.padStart(8) + '错误'.padStart(8),
    );
    for (const r of results) {
      console.log(
        r.name.padEnd(22) +
          r.rps.toFixed(1).padStart(10) +
          String(r.p50).padStart(10) +
          String(r.p99).padStart(10) +
          String(r.non2xx).padStart(8) +
          String(r.errors + r.timeouts).padStart(8),
      );
    }
    console.log('===========================================================');

    if (opts.out) {
      const outPath = path.resolve(opts.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(
        outPath,
        JSON.stringify(
          {
            node: process.version,
            platform: process.platform,
            startedAt: new Date().toISOString(),
            options: opts,
            results,
          },
          null,
          2,
        ),
      );
      console.log(`结果已写入 ${outPath}`);
    }
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
