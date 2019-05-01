var Fs = require("fs");
var Fse = require("fs-extra");
var Path = require("path");
var nacl = require("tweetnacl");
var nThen = require("nthen");

var Tasks = module.exports;

var tryParse = function (s) {
    try { return JSON.parse(s); }
    catch (e) { return null; }
};

var encode = function (time, command, args) {
    if (typeof(time) !== 'number') { return null; }
    if (typeof(command) !== 'string') { return null; }
    if (!Array.isArray(args)) { return [time, command]; }
    return [time, command].concat(args);
};

var randomId = function () {
    var bytes = Array.prototype.slice.call(nacl.randomBytes(16));
    return bytes.map(function (b) {
        var n = Number(b & 0xff).toString(16);
        return n.length === 1? '0' + n: n;
    }).join('');
};

var mkPath = function (env, id) {
    return Path.join(env.root, id.slice(0, 2), id) + '.ndjson';
};

var getFreeId = function (env, cb, tries) {
    if (tries > 5) { return void cb('ETOOMANYTRIES'); }

    // generate a unique id
    var id = randomId();

    // derive a path from that id
    var path = mkPath(env, id);

    Fs.stat(path, function (err) {
        if (err && err.code === "ENOENT") {
            cb(void 0, id);
        } else {
            getFreeId(env, cb);
        }
    });
};

var write = function (env, task, cb) {
    var str = JSON.stringify(task) + '\n';
    var id = nacl.util.encodeBase64(nacl.hash(nacl.util.decodeUTF8(str))).replace(/\//g, '-');

    var path = mkPath(env, id);
    nThen(function (w) {
        // check if the file already exists...
        Fs.stat(path, w(function (err) {
            if (err && err.code === 'ENOENT') { return; }
            w.abort(); cb();
        }));
    }).nThen(function (w) {
        // create the parent directory if it does not exist
        var dir = id.slice(0, 2);
        var dirpath = Path.join(env.root, dir);

        Fse.mkdirp(dirpath, 0x1ff, w(function (err) {
            if (err) {
                return void cb(err);
            }
        }));
    }).nThen(function () {
        // write the file to the path
        Fs.writeFile(mkPath(env, id), str, function (e) {
            if (e) { return void cb(e); }
            cb();
        });
    });
};

var list = Tasks.list = function (env, cb) {
    var rootDirs;

    nThen(function (w) {
        // read the root directory
        Fs.readdir(env.root, w(function (e, list) {
            if (e) { return void cb(e); }
            if (rootDirs.length === 0) {
                w.abort();
                return void cb(void 0, []);
            }
            rootDirs = list;
        }));
    }).nThen(function () {
        // schedule the nested directories for exploration
        // return a list of paths to tasks
        var queue = nThen(function () {});

        var allPaths = [];

        // We prioritize a small footprint over speed, so we
        // iterate over directories in serial rather than parallel
        rootDirs.forEach(function (dir) {
            queue.nThen(function (w) {
                var done = w();
                Fs.readdir(Path.join(env.root, dir), w(function (e, paths) {
                    if (e) {
                        // FIXME log
                        return void done();
                    }
                    // concat in place
                    Array.prototype.push.apply(allPaths, paths);
                    done();
                }));
            });
        });

        queue.nThen(function () {
            cb(void 0, allPaths);
        });
    });
};

var remove = function (env, path, cb) {
    Fs.unlink(path, cb);
};

var read = function (env, filePath, cb) {
    Fs.readFile(filePath, 'utf8', function (e, str) {
        if (e) { return void cb(e); }

        var task = tryParse(str);
        if (!Array.isArray(task) || task.length < 2) {
            return cb(new Error('INVALID_TASK'));
        }
        cb(void 0, task);
    });
};

var run = Tasks.run = function (env, path, cb) {
    var CURRENT = +new Date();

    var Log = env.log;
    var task, time, command, args;

    nThen(function (w) {
        read(env, path, w(function (err, _task) {
            if (err) {
                w.abort();
                return void cb(err);
            }
            task = _task;
            time = task[0];

            if (time > CURRENT) {
                w.abort();
                return cb();
            }

            command = task[1];
            args = task.slice(2);
        }));
    }).nThen(function (w) {
        switch (command) {
            case 'EXPIRE':
                Log.info('DELETION_SCHEDULED_EXPIRATION', {
                    task: task,
                });
                env.store.removeChannel(args[0], w());
                break;
            default:
                Log.warn("TASKS_UNKNOWN_COMMAND", task);
        }
    }).nThen(function () {
        // remove the task file...
        remove(path, function (err) {
            if (err) {
                Log.error('TASKS_RECORD_REMOVAL', {
                    path: path,
                    err: err,
                });
            }
        });
    });
};

var runAll = function (env, handler, cb) {
    var paths;

    nThen(function (w) {
        list(env, w(function (err, _paths) {
            if (err) {
                w.abort();
                return void cb(err);
            }
            paths = _paths;
        }));
    }).nThen(function (/*w*/) {
        // TODO
    // iterate with run
        // read(env, filePath, cb);
        // Tasks.run(str, filePath, cb);
    // delete if run
        // remove(filePath, cb);
    // log along the way
        // env.log ???
    }).nThen(function (/*w*/) {
    // callback when you're done
        // cb
        // TODO
    });
};

Tasks.create = function (config, cb) {
    if (!config.store) { throw new Error("E_STORE_REQUIRED"); }
    if (!config.log) { throw new Error("E_LOG_REQUIRED"); }

    var env = {
        root: config.taskPath || './tasks',
        log: config.log,
        store: config.store,
    };

    // make sure the path exists...
    Fse.mkdirp(env.root, 0x1ff, function (err) {
        if (err && err.code !== 'EEXIST') {
            throw err;
        }
        cb(void 0, {
            write: function (time, command, args, cb) {
                var task = encode(time, command, args);
                write(env, task, cb);
            },
            list: function (olderThan, cb) {
                list(env, olderThan, cb);
            },
            remove: function (id, cb) {
                remove(env, id, cb);
            },
            run: function (id, cb) {
                run(env, id, cb);
            },
            runAll: function (cb) {
                runAll(env, cb);
            },
        });
    });
};

