import { Injectable } from '../../../container/decorators';
import { Database } from '../../../database/Database';
import { DEFAULT_USER_LIST_LIMIT, TABLE } from '../constants';

export interface UserRow {
  id: number;
  name: string;
  email: string;
  createdAt: number;
}

/**
 * 用户服务：依赖注入 Database（由框架提供）。
 */
@Injectable()
export class UserService {
  constructor(private db: Database) {}

  async count(): Promise<number> {
    return this.db.table<UserRow>(TABLE.USERS).count();
  }

  async list(limit = DEFAULT_USER_LIST_LIMIT): Promise<UserRow[]> {
    return this.db
      .table<UserRow>(TABLE.USERS)
      .field('id', 'name', 'email', 'createdAt')
      .order('id', 'DESC')
      .limit(limit)
      .select();
  }

  async find(id: number): Promise<UserRow | null> {
    return this.db.table<UserRow>(TABLE.USERS).where('id', id).find();
  }

  async add(name: string, email: string): Promise<number> {
    const result = await this.db
      .table<UserRow>(TABLE.USERS)
      .add({ name, email, createdAt: Date.now() } as Partial<UserRow>);
    return result.insertId;
  }
}
