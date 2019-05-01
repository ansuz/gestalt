var Ecstatic = require("ecstatic");
var Http = require("http");

var Netflux = require("chainpad-server/NetfluxWebsocketSrv");
var WebSocketServer = require('ws').Server;
var nThen = require("nthen");


var Http = require('http');

var Unmon = require("unmon-router");

var config;
try { config = require("./config.js"); }
catch (e) { config = {}; }

var Storage = require(config.storage||'./storage/file');
var Static = Ecstatic({
    root: config.www || 'www',
    //handleError: false,
});

var app = Unmon();

app.route(/.*$/, function (req, res, next) {
    console.log(req.url);
    next();
});

app.route(/^\/bundle.js.map$/, function (req, res, next) {
    res.setHeader('X-SourceMap', '/bundle.js.map');
    next();
});

app.route(/\?cache=sha384\-[a-zA-Z0-9\+\/]+$/, function (req, res, next) {
    // cache these files forever since they are content-addressed
    res.setHeader('Cache-Control', 'max-age=31556926');
    next();
});

app.route(/^\/(|index\.html)$/, function (req, res, next) {
    // always fetch a fresh home page
    res.setHeader('Cache-Control', 'no-cache');
    next();
});

app.route(/.*/, function (req, res) {
    Static(req, res);
});


var server = Http.createServer(app.compile());

var addr = config.addr = config.addr || '0.0.0.0';
var port = config.port = config.port || 8000;
var pretty = config.pretty = 'http://' +
        (/:/.test(addr)? '[' + addr + ']': addr) +
        (port === 80? '': ':' + port);

var historyKeeper;
var log;
//var rpc;

nThen(function (w) {
    var Logger = require('./lib/log');
    Logger.create(config, w(function (_log) {
        log = config.log = _log;
    }));
}).nThen(function (w) {
    server.listen(port, addr, function () {
        console.log('listening on %s', pretty);
    });
}).nThen(function (w) {
    if (config.useExternalWebsocket) { return; }
    Storage.create(config, w(function (_store) {
        config.store = _store;
    }));
}).nThen(function (w) {
    if (!config.enableTaskScheduling) { return; }
    var Tasks = require("./storage/tasks");
    Tasks.create(config, w(function (e, tasks) {
        config.tasks = tasks;
    }));
}).nThen(function (w) {
    /* TODO RPC
    config.rpc = typeof(config.rpc) === 'undefined'? './rpc.js' : config.rpc;
    if (typeof(config.rpc) !== 'string') { return; }
    // load pin store...
    var Rpc = require(config.rpc);
    Rpc.create(config, debuggable, w(function (e, _rpc) {
        if (e) {
            w.abort();
            throw e;
        }
        rpc = _rpc;
    }));

    */
}).nThen(function (w) {
    var HK = require('./historyKeeper.js');
    var hkConfig = {
        tasks: config.tasks,
        //rpc: rpc,
        store: config.store,
        log: log
    };
    historyKeeper = HK.create(hkConfig);
}).nThen(function () {
    var wsSrv = new WebSocketServer({
        server: server
    });
    Netflux.run(wsSrv, config, historyKeeper);
})
