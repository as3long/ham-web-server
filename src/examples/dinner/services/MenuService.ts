import { Injectable } from '../../../container/decorators';
import { Database } from '../../../database/Database';
import { safeSeed } from '../../shared/seed';
import {
  AVAILABILITY,
  CENTS_PER_YUAN,
  DEFAULT_CATEGORY,
  MAX_PRICE_YUAN,
  TABLE,
} from '../constants';

export interface DishRow {
  id: number;
  name: string;
  /** 分类：招牌菜 / 主食 / 小吃饮品 / 甜品 */
  category: string;
  /** 价格，单位：分（整数存储，避免浮点精度问题） */
  price: number;
  description: string;
  /** 1 = 上架可点，0 = 已下架 */
  isAvailable: number;
  createdAt: number;
}

/** 菜单分组（菜单页按分类渲染） */
export interface DishGroup {
  category: string;
  items: DishRow[];
}

/** 展示用：附加 priceYuan 字段（分 -> 元字符串） */
export type DishView = DishRow & { priceYuan: string };

export function withPriceYuan<T extends { price: number }>(row: T): T & { priceYuan: string } {
  return {
    ...row,
    priceYuan: (row.price / CENTS_PER_YUAN).toFixed(2),
  };
}

/**
 * 菜单服务：菜品的增删改查与菜单分组。
 * 价格一律以“分”为单位的整数存储，展示层再格式化为元。
 */
@Injectable()
export class MenuService {
  constructor(private db: Database) {}

  async ensureTable(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS ham_dishes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '招牌菜',
        price INTEGER NOT NULL DEFAULT 0,
        description TEXT NOT NULL DEFAULT '',
        isAvailable INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  /** 首次运行填充示例菜品（多进程安全：只有一个 worker 会真正写入） */
  async seedIfEmpty(): Promise<void> {
    await safeSeed(
      this.db,
      'dinner-menu',
      async () => {
        const samples: Array<[string, string, number, string]> = [
          ['红烧狮子头', '招牌菜', 2880, '四成肥六成瘦，慢火炖足两小时'],
          ['秘制烤鸭（半只）', '招牌菜', 4580, '果木挂炉，皮酥肉嫩配荷叶饼'],
          ['麻婆豆腐', '招牌菜', 1680, '麻辣鲜香烫，正宗郫县豆瓣'],
          ['扬州炒饭', '主食', 1580, '粒粒分明，火腿虾仁青豆'],
          ['手工牛肉面', '主食', 2280, '牛骨熬汤六小时，面条现拉'],
          ['阳春面', '主食', 880, '清汤葱香，简单却不敷衍'],
          ['蒜香小龙虾', '小吃饮品', 5880, '中份约一斤，蒜香入味'],
          ['炸鸡翅（4 只）', '小吃饮品', 1280, '外脆里嫩，配椒盐蘸料'],
          ['酸梅汤', '小吃饮品', 680, '乌梅山楂桂花，冰镇解腻'],
          ['鲜榨橙汁', '小吃饮品', 980, '现点现榨，不加一滴水'],
          ['杨枝甘露', '甜品', 1580, '芒果西柚西米露'],
          ['双皮奶', '甜品', 980, '水牛奶炖制，奶皮厚润'],
        ];
        for (const [name, category, price, description] of samples) {
          await this.db.table<DishRow>(TABLE.DISHES).add({
            name,
            category,
            price,
            description,
            isAvailable: AVAILABILITY.ON,
            createdAt: Date.now(),
          } as Partial<DishRow>);
        }
      },
    );
  }

  /** 菜单页：仅上架菜品，按分类分组（保持插入顺序） */
  async groupedMenu(): Promise<DishGroup[]> {
    const rows = await this.db
      .table<DishRow>(TABLE.DISHES)
      .where({ isAvailable: AVAILABILITY.ON })
      .order('id', 'ASC')
      .select();
    const groups = new Map<string, DishRow[]>();
    for (const row of rows) {
      if (!groups.has(row.category)) groups.set(row.category, []);
      groups.get(row.category)!.push(row);
    }
    return [...groups.entries()].map(([category, items]) => ({ category, items }));
  }

  /** 管理后台：全部菜品（含下架） */
  async all(): Promise<DishRow[]> {
    return this.db.table<DishRow>(TABLE.DISHES).order('id', 'ASC').select();
  }

  async byId(id: number): Promise<DishRow | null> {
    return this.db.table<DishRow>(TABLE.DISHES).where({ id }).find();
  }

  /** 购物车/下单时的批量校验：返回存在的上架菜品 */
  async availableByIds(ids: number[]): Promise<DishRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .table<DishRow>(TABLE.DISHES)
      .order('id', 'ASC')
      .select();
    const set = new Set(ids);
    return rows.filter(
      (r) => set.has(r.id) && r.isAvailable === AVAILABILITY.ON,
    );
  }

  /** 新增或保存菜品（id=0 视为新增）。返回错误消息，null 表示成功 */
  async save(input: {
    id: number; name: string; category: string; priceYuan: string; description: string;
  }): Promise<string | null> {
    const name = input.name.trim();
    if (!name) return '菜品名称不能为空';
    const priceYuan = Number(input.priceYuan);
    if (!(priceYuan > 0) || priceYuan > MAX_PRICE_YUAN) {
      return `价格需为 0-${MAX_PRICE_YUAN} 元`;
    }
    const price = Math.round(priceYuan * CENTS_PER_YUAN);
    const category = input.category.trim() || DEFAULT_CATEGORY;

    if (input.id > 0) {
      const existing = await this.byId(input.id);
      if (!existing) return '菜品不存在';
      await this.db
        .table<DishRow>(TABLE.DISHES)
        .where({ id: input.id })
        .update({
          name,
          category,
          price,
          description: input.description.trim(),
        } as Partial<DishRow>);
    } else {
      await this.db.table<DishRow>(TABLE.DISHES).add({
        name,
        category,
        price,
        description: input.description.trim(),
        isAvailable: AVAILABILITY.ON,
        createdAt: Date.now(),
      } as Partial<DishRow>);
    }
    return null;
  }

  /** 上架/下架切换 */
  async toggle(id: number): Promise<void> {
    const dish = await this.byId(id);
    if (!dish) return;
    await this.db
      .table<DishRow>(TABLE.DISHES)
      .where({ id })
      .update({
        isAvailable:
          dish.isAvailable === AVAILABILITY.ON
            ? AVAILABILITY.OFF
            : AVAILABILITY.ON,
      } as Partial<DishRow>);
  }

  async remove(id: number): Promise<void> {
    await this.db.table<DishRow>(TABLE.DISHES).where({ id }).delete();
  }
}
