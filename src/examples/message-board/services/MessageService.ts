import { Injectable } from '../../../container/decorators';
import { Database } from '../../../database/Database';
import { safeSeed } from '../../shared/seed';
import {
  ADMIN_FLAG,
  DEFAULT_PAGE_NO,
  DEFAULT_PAGE_SIZE,
  TABLE,
} from '../constants';

export interface MessageRow {
  id: number;
  nickname: string;
  content: string;
  ip: string;
  /** 发帖时作者是否为管理员（身份快照，发布时记录） */
  isAdmin: number;
  createdAt: number;
}

export interface MessagePage {
  list: MessageRow[];
  total: number;
  page: number;
  size: number;
  pages: number;
}

/**
 * 留言板服务：依赖注入 Database（框架提供，SQLite 驱动）。
 */
@Injectable()
export class MessageService {
  constructor(private db: Database) {}

  /** 建表（幂等，应用启动时调用）；旧库自动补 isAdmin 列 */
  async ensureTable(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS ham_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nickname TEXT NOT NULL DEFAULT '匿名',
        content TEXT NOT NULL,
        ip TEXT NOT NULL DEFAULT '',
        isAdmin INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL DEFAULT 0
      )
    `);
    // 老库迁移：已存在但无 isAdmin 列时补上（新列默认 0，旧留言视为普通用户发布）
    try {
      await this.db.exec('ALTER TABLE ham_messages ADD COLUMN isAdmin INTEGER NOT NULL DEFAULT 0');
    } catch { /* 列已存在 */ }
  }

  /** 分页留言列表（按 id 倒序） */
  async pageList(pageNo: number, size = DEFAULT_PAGE_SIZE): Promise<MessagePage> {
    const total = await this.db.table<MessageRow>(TABLE.MESSAGES).count();
    const page = Math.max(DEFAULT_PAGE_NO, Math.floor(pageNo) || DEFAULT_PAGE_NO);
    const list = await this.db
      .table<MessageRow>(TABLE.MESSAGES)
      .order('id', 'DESC')
      .page(page, size)
      .select();
    return {
      list,
      total,
      page,
      size,
      pages: Math.max(1, Math.ceil(total / size)),
    };
  }

  /**
   * 新增留言，返回自增 id。
   * @param isAdmin 发帖时作者的管理员标志（身份快照，供列表徽标展示）
   */
  async add(
    nickname: string,
    content: string,
    ip = '',
    isAdmin: number = ADMIN_FLAG.NO,
  ): Promise<number> {
    const result = await this.db
      .table<MessageRow>(TABLE.MESSAGES)
      .add({ nickname, content, ip, isAdmin, createdAt: Date.now() } as Partial<MessageRow>);
    return result.insertId;
  }

  /** 删除留言（管理操作，配合 AdminTokenGuard 使用） */
  async remove(id: number): Promise<void> {
    await this.db.table<MessageRow>(TABLE.MESSAGES).where({ id }).delete();
  }

  /** 首次运行时填充示例数据（多进程安全：只有一个 worker 会真正写入） */
  async seedIfEmpty(): Promise<void> {
    const seeded = await safeSeed(
      this.db,
      'message-board',
      async () => {
        const samples: Array<[string, string]> = [
          ['张三', '这个框架用起来真顺手，链式 ORM 和 ThinkPHP 一个感觉。'],
          ['李四', '构造函数里声明依赖就自动注入了，再也不用全局变量了！'],
          ['王五', '/board/api 这个 JSON 接口速度怎么样？待会用 ab 压一下。'],
          ['小明', 'SQLite 内置在 Node 24 里，零编译依赖，好评。'],
          ['小红', '会话会把我的昵称记住，下次直接填好了。'],
          ['阿强', '分页查询 page(2, 10) 一行搞定。'],
          ['建国', 'action 直接 return 对象就输出 JSON，写接口真快。'],
          ['小芳', '模板默认转义，XSS 过滤双重保障。'],
          ['大壮', 'request 作用域的 Context 每个请求独立，不会串数据。'],
          ['铁柱', '循环依赖还能自动检测出来，报错很清晰。'],
          ['翠花', '静态资源带 Cache-Control，浏览器缓存 120 秒。'],
          ['老王', '这个留言板就是一个完整的例子：服务 + 控制器 + 视图 + 会话。'],
        ];
        for (const [nickname, content] of samples) {
          await this.add(nickname, content);
        }
      },
    );
  }
}
