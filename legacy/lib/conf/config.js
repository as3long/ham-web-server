module.exports={
    sqlite_path:APP_PATH+'/ham/dbfile/ham.sqlite',
    loki_path:APP_PATH+'/ham/dbfile/ham.json',
    db_type: 'sqlite', // 数据库类型
    db_host: 'localhost', // 服务器地址
    db_port: '3306', // 端口
    db_name: 'nodejs', // 数据库名
    db_user: 'root', // 用户名
    db_pwd: 'boxing', // 密码
    db_prefix: 'ham_', // 数据库表前缀
    'db_charset': 'UTF8',
	'db_conn_limit': 5,
    //数据库缓存时间
    sql_cache_time:1000*60*10,
    //session保存时间
    session_expires:30*60*1000,
    session_key:"ham_session_id"
}