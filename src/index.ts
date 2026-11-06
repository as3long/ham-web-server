import 'reflect-metadata';

export { HamApplication, AppOptions } from './application';
export { Container, RegisterOptions } from './container/Container';
export {
  Injectable,
  Inject,
  Autowired,
  Controller,
  UseInterceptors,
  collectInterceptors,
  UseGuards,
  collectGuards,
} from './container/decorators';
export {
  HTTP_STATUS,
  HttpStatus,
  CONTENT_TYPE,
  MIME_TYPE,
  HTTP_METHOD,
  HTTP_HEADER,
  SECOND_MS,
  MINUTE_MS,
  DEFAULT_CONTROLLER,
  DEFAULT_ACTION,
  DEFAULT_HOST,
} from './constants';
export { ConfigService } from './config/ConfigService';
export { Logger, LoggerLike, LogLevel, LogFn } from './logging/Logger';
export { BaseController } from './controller/BaseController';
export { Context } from './core/Context';
export { Router, parseRoute, RouteMatch } from './core/Router';
export { StaticServer } from './core/StaticServer';
export {
  SessionService,
  createLazySession,
} from './core/SessionService';
export {
  SessionStore,
  MemorySessionStore,
  DatabaseSessionStore,
  createSessionStore,
  generateSessionId,
  needsSessionPersist,
} from './core/SessionStore';
export {
  runCluster,
  ClusterOptions,
  isManagedProcess,
  isMultiProcessRuntime,
  isPrimaryProcess,
  runOnce,
} from './cluster';
export {
  Interceptor,
  InterceptorLike,
  FunctionalInterceptor,
  Next,
  compose,
  toInterceptor,
} from './core/interceptor';
export {
  Guard,
  GuardLike,
  FunctionalGuard,
  canAllActivate,
  toGuard,
} from './core/guard';
export { ViewEngine } from './view/ViewEngine';
export { Database, QueryBuilder, CompiledSql } from './database/Database';
export { DbDriver, SqliteDriver, MysqlDriver, ExecResult } from './database/drivers';
export { LRUCache } from './cache/LRUCache';
export {
  HamConfig,
  DEFAULT_CONFIG,
  Scope,
  Token,
  Type,
  Session,
  PostData,
  UploadedFile,
} from './types';
export {
  md5,
  rand,
  randString,
  parseCookie,
  serializeCookie,
  appendSetCookie,
  mkdirp,
  formatDate,
  formatDateTime,
  getSummary,
  isPromise,
} from './utils';

import { HamApplication } from './application';
import {
  Autowired,
  Controller,
  Inject,
  Injectable,
  UseGuards,
  UseInterceptors,
} from './container/decorators';
import { Container } from './container/Container';
import { BaseController } from './controller/BaseController';
import { ConfigService } from './config/ConfigService';
import { Context } from './core/Context';
import { compose as composeInterceptors } from './core/interceptor';
import { canAllActivate as canAllActivateGuards } from './core/guard';
import { Database } from './database/Database';
import { Logger } from './logging/Logger';
import { SessionService } from './core/SessionService';
import { ViewEngine } from './view/ViewEngine';
import { LRUCache } from './cache/LRUCache';

export const VERSION = '2.0.0';

/**
 * 兼容 1.x 的全局 Ham 门面对象：
 *   import Ham from 'ham-web-server';
 */
const Ham = {
  VERSION,
  HamApplication,
  Container,
  Injectable,
  Inject,
  Autowired,
  Controller,
  UseInterceptors,
  UseGuards,
  composeInterceptors,
  canAllActivateGuards,
  BaseController,
  ConfigService,
  Context,
  Database,
  Logger,
  SessionService,
  ViewEngine,
  LRUCache,
};
export default Ham;
