/**
 * 轻量级缓存：容量 + 过期时间（TTL）。
 * 容量满时淘汰最久未被访问的键（真 LRU：Map 插入顺序即访问顺序）。
 */
export class LRUCache<V = any> {
  private map = new Map<string, { value: V; expires: number }>();

  constructor(
    private capacity = 500,
    private defaultTtl = 0,
  ) {
    if (capacity < 1) {
      throw new Error(`LRUCache 容量必须为正数，收到: ${capacity}`);
    }
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires !== 0 && Date.now() > entry.expires) {
      this.map.delete(key);
      return undefined;
    }
    // 命中后移到 Map 末尾，维持 LRU 顺序
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  has(key: string): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (entry.expires !== 0 && Date.now() > entry.expires) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  set(key: string, value: V, ttl?: number): this {
    const now = Date.now();
    const effective = ttl ?? this.defaultTtl;
    // 已存在的键先删除，重新插入到末尾
    this.map.delete(key);
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, {
      value,
      expires: effective > 0 ? now + effective : 0,
    });
    return this;
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    this.sweepExpired();
    return this.map.size;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.expires !== 0 && now > entry.expires) this.map.delete(key);
    }
  }
}
