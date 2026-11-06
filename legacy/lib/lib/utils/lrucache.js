(function (factory) {
    // Set up Mobilebone appropriately for the environment.
    if (typeof require === 'function' && typeof exports === 'object' && typeof module === 'object') {
        // [1] CommonJS/Node.js
        // [1] 支持在module.exports.abc,或者直接exports.abc
        var target = module['exports'] || exports; // module.exports is for Node.js
        factory(target);
    } else if (typeof define === 'function' && (define.amd || define.cmd)) {
        define('lrucache', factory);
    } else {
        factory(window);
    }
})(function (root) {
    var Class=require("./../../Class");
    root.lrucache = Class.extend({
        dict: {},
        capacity: 50,
        length: 0,
        defaultTime:0,
        initClass: function (capacity) {
            if (capacity < 1) {
                throw new Error('LRU Cache must have a positive capacity : ' + capacity + ' provided');
            }
            this.capacity = capacity;
        },
        setDefaultTime:function(time){
            this.defaultTime=time;
        },
        get: function (key) {
            this.checkTime();
            if (this.dict[key]) {
                this.dict[key].use++;
                return this.dict[key].value;
            } else {
                return undefined;
            }
        },
        has:function(key){
            return !!this.dict[key];
        },
        remove: function (key) {
            if (this.dict[key]) {
                delete this.dict[key];
                this.length--;
            }
        },
        clear: function () {
            for (var key in this.dict) {
                delete this.dict[key];
                this.length--;
            }
        },
        size: function () {
            return this.length;
        },
        set: function (key, value, time) {
            this.checkTime();
            if (!this.dict[key]) {
                if (this.length >= this.capacity) {
                    this.removeLazy();
                }
                this.length++;
            }
            this.dict[key] = {
                value: value,
                use: 0,
                create: Date.now()
            };
            if (time) {
                this.dict[key].time = this.dict[key].create + time;
            } else if(this.defaultTime==0){
                this.dict[key].time = 0;
            }else{
                this.dict[key].time = this.dict[key].create + this.defaultTime;
            }
        },
        checkTime: function () {
            var nowTime = Date.now();
            for (var key in this.dict) {
                if (this.dict[key].time == 0) {
                    continue;
                }
                if (nowTime > this.dict[key].time) {
                    delete this.dict[key];
                    this.length--;
                }
            }
        },
        debug:function(){
            console.log(this.dict);
        },
        removeLazy: function () {
            var minUse =Number.MAX_VALUE;//90071992547409,
            var minKey = null;
            for (var key in this.dict) {
                if (this.dict[key].use < minUse) {
                    minUse = this.dict[key].use;
                    minKey = key;
                }
            }
            delete this.dict[minKey];
            this.length--;
        }
    });
});