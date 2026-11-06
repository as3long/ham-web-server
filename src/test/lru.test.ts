import { strict as assert } from 'assert';
import { test } from 'node:test';
import { LRUCache } from '../cache/LRUCache';

test('LRUCache: 容量淘汰与 TTL', async () => {
  const cache = new LRUCache<number>(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // a 命中次数变高
  cache.set('c', 3); // 淘汰 b
  assert.strictEqual(cache.get('a'), 1);
  assert.strictEqual(cache.get('b'), undefined);
  assert.strictEqual(cache.get('c'), 3);

  // 命中会刷新 LRU 顺序：a 被访问后，淘汰的应是最久未用的 b
  const lru = new LRUCache<number>(3);
  lru.set('a', 1);
  lru.set('b', 2);
  lru.set('c', 3);
  lru.get('a');
  lru.set('d', 4); // 淘汰 b
  assert.strictEqual(lru.get('b'), undefined);
  assert.strictEqual(lru.get('a'), 1);
  assert.strictEqual(lru.get('c'), 3);
  assert.strictEqual(lru.get('d'), 4);

  const ttlCache = new LRUCache<string>(10, 30);
  ttlCache.set('k', 'v');
  assert.strictEqual(ttlCache.get('k'), 'v');
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(ttlCache.get('k'), undefined);
  assert.strictEqual(ttlCache.has('k'), false);
});
