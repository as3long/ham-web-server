var Class = require("./../../Class");
var mysql = require('mysql');
var config = require(APP_PATH + "/ham/conf/config.js");
var utils = require('./utils');
var Query = require('sql-query');
var LRU = require("./../utils/lrucache").lrucache;
var CACHE_TIME = Ham.config.sql_cache_time || 1000 * 60 * 5;
var cache = LRU.create(500);
/**
 * 简单的数据模型
 * https://www.digitalocean.com/?refcode=a51bf433f131
 */
module.exports = Class.extend({
    addTemp: {},
    addAllTemp: [],
    fieldTemp: [],
    updateTemp: {},
    tableName: '',
    orderTemp: null,
    whereTemp: null,
    limitNum: -1,
    db_prefix: '',
    joinTemp: null,
    pageTemp: {},
    countTemp: "",
    cacheFleg: false,
    cacheFunc: cache,
    pool: null,
    initClass: function (dbName) {
        if (dbName) {
            this.db_prefix = config.db_prefix || '';
            var options = {
                'host': config.db_host,
                'port': config.db_port,
                'database': config.db_name,
                'user': config.db_user,
                'password': config.db_pwd,
                'charset': config.db_charset,
                'connectionLimit': config.db_conn_limit,
                'supportBigNumbers': true,
                'bigNumberStrings': true
            };
            this.pool = mysql.createPool(options);
        } else {
            this.addTemp = {};
            this.addAllTemp = [];
            this.fieldTemp = [];
            this.updateTemp = {};
            this.orderTemp = null;
            this.whereTemp = null;
            this.joinTemp = null;
            this.limitNum = -1;
            this.pageTemp = {};
            this.cacheFleg = false;
            this.countTemp = '';
        }
    },
    /**
     * [[查找]]
     */
    find: function () {
        return this.queryParams("find");
    },
    select: function () {
        return this.queryParams("select");
    },
    table: function (tableName) {
        this.tableName = this.db_prefix + tableName;
        this.initClass();
        return this;
    },
    cache: function () {
        this.cacheFleg = true;
        return this;
    },
    /**
     * [[where]]
     */
    where: function (obj) {
        if (isObject(obj)) {
            this.whereTemp = obj;
        } else if (arguments.length == 2 && isString(obj)) {
            this.whereTemp = this.whereTemp || {};
            this.whereTemp[obj] = arguments[1];
        }
        return this;
    },
    order: function (obj) {
        this.orderTemp = obj;
        return this;
    },
    limit: function (limitNum) {
        this.limitNum = limitNum;
        return this;
    },
    page: function (page, size) {
        page = page || 1;
        size = size || 6
        this.pageTemp.page = page;
        this.pageTemp.size = size;
        return this;
    },
    count: function (id) {
        var deferred = getDefer();
        this.countTemp = id || null;
        this.queryParams("count").then(function (data) {
            if (data.length > 0) {
                data = data[0];
                for (var k in data) {
                    deferred.resolve(data[k]);
                    break;
                }
            } else {
                deferred.resolve(0);
            }
        });
        return deferred.promise;
    },
    /**
     * [[通过sql字符串查询]]
     */
    query: function (sql) {
        var deferred = getDefer();
        var self = this;
        if (self.cacheFleg && cache.has(sql)) {
            deferred.resolve(cache.get(sql));
        } else {
            $A.debug("orange", sql);
            if (APP_DEBUG) {
                appendFileContent(APP_PATH + "/last.sql", sql + "\n");
            }
            db.query(sql, function (err, rows) {
                if (err) {
                    $A.debug("red", JSON.stringify(err));
                    deferred.reject(err);
                } else {
                    if (self.cacheFleg) {
                        cache.set(sql, rows, CACHE_TIME);
                    }
                    deferred.resolve(rows);
                }
            });
        }
        return deferred.promise;
    },
    field: function (arr) {
        this.fieldTemp = this.fieldTemp.concat(arr);
        return this;
    },
    join: function (t2Name, t2Item, tItem) {
        this.joinTemp = {
            t2Name: this.db_prefix + t2Name,
            t2Item: t2Item,
            tItem: tItem
        }
        return this;
    },
    /**
     * [[添加]]
     */
    add: function (obj) {
        utils.merge(this.addTemp, obj, true);
        return this.queryParams("add");
    },
    /**
     * [[删除]]
     */
    delete: function () {
        return this.queryParams("delete");
    },
    /**
     * [[更新]]
     */
    update: function (obj) {
        utils.merge(this.updateTemp, obj, true);
        return this.queryParams("update");
    },
    queryParams: function (str) {
        var sql = "";
        var q = new(Query.Query)(this.dialect);
        switch (str) {
        case "add":
            sql = q.insert().into(this.tableName).set(this.addTemp).build();
            break;
        case "update":
            sql = q.update().into(this.tableName).where(this.whereTemp).set(this.updateTemp).build();
            break;
        case "find":
        case "select":
            if(str=="find"){
                this.limitNum = 1;
            }
            var findQ = q.select().from(this.tableName);
            if (this.joinTemp) {
                findQ = findQ.from(this.joinTemp.t2Name, this.joinTemp.t2Item, this.tableName, this.joinTemp.tItem);
            }
            findQ = findQ.select(this.fieldTemp).where(this.whereTemp);
            if (this.pageTemp.page) {
                findQ = findQ.limit("" + (this.pageTemp.page - 1) * this.pageTemp.size + "," + this.pageTemp.size);
            } else if (this.limitNum > 0) {
                findQ = findQ.limit(this.limitNum);
            }
            if (this.orderTemp) {
                if (isString(this.orderTemp)) {
                    findQ = findQ.order(this.orderTemp);
                } else {
                    findQ = findQ.order(this.orderTemp[0], this.orderTemp[1] || "A");
                }
            }
            sql = findQ.build();
            break;
        case "delete":
            var deleteQ = q.remove().from(this.tableName).where(this.whereTemp);
            sql = deleteQ.build();
            break;
        case "count":
            var countQ = q.select().from(this.tableName).count(this.countTemp).where(this.whereTemp);
            sql = countQ.build();
            break;
        default:
            break;
        }
        return this.query(sql);
    },
    addAll: function (objs) {
        var key;
        var keyArr = [];
        var valueArr = [];
        var sql = "BEGIN;";
        var q = new(Query.Query)(this.dialect);
        console.log(objs);
        for (var i = 0; i < objs.length; i++) {
            sql += q.insert().into(this.tableName).set(objs[i]).build() + ";";
        }
        sql += "COMMIT;"
        return this.query(sql);
    },
    /**
     * [[通过sql字符串查询]]
     */
    query: function (sql) {
        var deferred = getDefer();
        var self = this;
        if (self.cacheFleg && self.cacheFunc.has(sql)) {
            deferred.resolve(self.cacheFunc.get(sql));
        } else {
            $A.debug("orange", sql);
            if (APP_DEBUG) {
                appendFileContent(APP_PATH + "/last.sql", sql + "\n");
            }
            self.pool.getConnection(function (err, connection) {
                if (err) {
                    $A.debug("red", 'DB-获取数据库连接异常！');
                    deferred.reject(err);
                } else {
                    connection.query(sql, function (err, rows) {
                        if (err) {
                            $A.debug("red", JSON.stringify(err));
                            deferred.reject(err);
                        } else {
                            if (self.cacheFleg) {
                                self.cacheFunc.set(sql, rows);
                            }
                            deferred.resolve(rows);
                        }
                    });
                    // 返回连接池
                    connection.release(function(error) {
                        if(error) {
                            log.error('DB-关闭数据库连接异常！');
                            throw error;
                        }
                    });
                }
            });
        }
        return deferred.promise;
    }
});
