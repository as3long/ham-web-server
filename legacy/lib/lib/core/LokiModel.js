var loki = require("lokijs"),
    fs = require("fs");
var lokiModel = Ham.Class.extend({
    db: null,
    db_path: null,
    tableName: null,
    collectionDict:{},
    listCollections:null,
    collection:null,
    initDB: function (db_path) {
        db_path=db_path||Ham.config.loki_path;
        var self=this;
        var deferred = getDefer();
        if (self.db == null && db_path) {
            self.db = new loki(db_path);
            self.db_path = db_path;
            fs.exists(self.db_path, function (exists) {
                if (exists) {
                    self.db.loadDatabase(function (data) {
                        deferred.resolve();
                    });
                } else {
                    self.db.save(function () {
                        deferred.resolve();
                    });
                }
            });
        }else {
            deferred.resolve();
        }
        return deferred.promise;
    },
    chain:function(){
        return this.collection.chain();
    },
    table: function (name) {
        if(this.collectionDict[name]==null){
            var list=this.db.listCollections();
            var hasFleg=false;
            for(var i=0,len=list.length;i<len;i++){
                 if(list[i].name==name){
                    hasFleg=true;
                    break;   
                }
            }
            if(hasFleg){
                this.collectionDict[name] =this.db.getCollection(name);
            }else{
                 this.collectionDict[name] =this.db.addCollection(name);
            }
        }
        this.collection=this.collectionDict[name];
        return this;
    },
    add: function (obj) {
        this.collection.insert(obj);
        return this.save();
    },
    find: function (obj) {
        return this.collection.find(obj);
    },
    get:function(key){
        return this.collection.get(key);
    },
    update: function (obj) {
        this.collection.update(obj);
        return this.save();
    },
    delete: function (obj) {
        this.collection.remove(obj);
        return this.save();
    },
    query:function(){
    
    },
    save: function () {
        var deferred = getDefer();
        this.db.save(function () {
            deferred.resolve(arguments);
        });
        return deferred.promise;
    }
});
module.exports=lokiModel.create();