/**
 * isPrimaryProcess / runOnce 测试。
 *
 * 测试进程不是 cluster worker，因此默认环境等价于“单进程主进程”；
 * 通过临时修改 process.env 模拟 PM2 的实例号，结束后一律还原。
 */
import { strict as assert } from 'assert';
import { test } from 'node:test';
import { isPrimaryProcess, runOnce } from '../cluster';

/** 临时设置环境变量，返回还原函数 */
function setEnv(vars: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('isPrimaryProcess: 非 PM2 且非 worker 时返回 true', () => {
  const restore = setEnv({ NODE_APP_INSTANCE: undefined, pm_id: undefined });
  try {
    assert.strictEqual(isPrimaryProcess(), true);
  } finally {
    restore();
  }
});

test('isPrimaryProcess: PM2 cluster 模式仅实例 0 视为主进程', () => {
  const restore = setEnv({ NODE_APP_INSTANCE: '0', pm_id: '0' });
  try {
    assert.strictEqual(isPrimaryProcess(), true);
  } finally {
    restore();
  }

  const restore2 = setEnv({ NODE_APP_INSTANCE: '2', pm_id: '5' });
  try {
    assert.strictEqual(isPrimaryProcess(), false);
  } finally {
    restore2();
  }
});

test('isPrimaryProcess: PM2 fork 模式未设置实例号时视为唯一主进程', () => {
  // pm_id 是全局计数器（可能为 3），不能作为实例号参与判断
  const restore = setEnv({ NODE_APP_INSTANCE: undefined, pm_id: '3' });
  try {
    assert.strictEqual(isPrimaryProcess(), true);
  } finally {
    restore();
  }
});

test('runOnce: 主进程执行任务并透传返回值', async () => {
  const restore = setEnv({ NODE_APP_INSTANCE: undefined, pm_id: undefined });
  try {
    let calls = 0;
    const result = await runOnce(() => {
      calls += 1;
      return 'ok';
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(result, 'ok');
  } finally {
    restore();
  }
});

test('runOnce: 非主进程跳过任务并返回 undefined', async () => {
  const restore = setEnv({ NODE_APP_INSTANCE: '1', pm_id: '1' });
  try {
    let calls = 0;
    const result = await runOnce(() => {
      calls += 1;
      return 'x';
    });
    assert.strictEqual(calls, 0);
    assert.strictEqual(result, undefined);
  } finally {
    restore();
  }
});
