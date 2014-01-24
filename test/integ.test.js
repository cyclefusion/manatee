var assert = require('assert-plus');
var bunyan = require('bunyan');
var ConfParser = require('../lib/confParser');
var fs = require('fs');
var exec = require('child_process').exec;
var path = require('path');
var mantee_common = require('../bin/manatee_common');
var Manatee = require('./testManatee');
var once = require('once');
var spawn = require('child_process').spawn;
var shelljs = require('shelljs');
var util = require('util');
var uuid = require('node-uuid');
var vasync = require('vasync');
var verror = require('verror');

var FS_PATH_PREFIX = process.env.FS_PATH_PREFIX || '/var/tmp/manatee_tests';
var ZK_URL = process.env.ZK_URL || 'localhost:2181';
var PARENT_ZFS_DS = process.env.PARENT_ZFS_DS;
var SHARD_ID = uuid.v4();
var SHARD_PATH = '/manatee/' + SHARD_ID;
var SITTER_CFG = './etc/sitter.json';
var BS_CFG = './etc/backupserver.json';
var SS_CFG = './etc/snapshotter.json';
var MY_IP = '127.0.0.1';
var ZK_CLIENT = null;

var LOG = bunyan.createLogger({
    level: (process.env.LOG_LEVEL || 'info'),
    name: 'manatee-integ-tests',
    serializers: {
        err: bunyan.stdSerializers.err
    },
    src: true
});

var MANATEES = {};

/*
 * Tests
 */

exports.before = function (t) {
    var n1 = uuid.v4();
    var n1Port = 10000;
    var n2 = uuid.v4();
    var n2Port = 20000;
    var n3 = uuid.v4();
    var n3Port = 30000;
    var n1Opts = {
        zfsDataset: PARENT_ZFS_DS + '/' + n1,
        zfsPort: n1Port,
        heartbeatServerPort: ++n1Port,
        mountPoint: FS_PATH_PREFIX + '/' + n1,
        backupPort: ++n1Port,
        postgresPort: ++n1Port,
        cookieLocation: FS_PATH_PREFIX + '/' + n1 + '_metadata' + '/cookie',
        backupServerPort: ++n1Port,
        configLocation: FS_PATH_PREFIX + '/' + n1 + '_metadata' + '/config',
        metadataDir: FS_PATH_PREFIX + '/' + n1 + '_metadata',
        shardPath: SHARD_PATH,
        log: LOG
    };
    var n2Opts = {
        zfsDataset: PARENT_ZFS_DS + '/' + n2,
        zfsPort: n2Port,
        heartbeatServerPort: ++n2Port,
        mountPoint: FS_PATH_PREFIX + '/' + n2,
        backupPort: ++n2Port,
        postgresPort: ++n2Port,
        cookieLocation: FS_PATH_PREFIX + '/' + n2 + '_metadata' + '/cookie',
        backupServerPort: ++n2Port,
        configLocation: FS_PATH_PREFIX + '/' + n2 + '_metadata' + '/config',
        metadataDir: FS_PATH_PREFIX + '/' + n2 + '_metadata',
        shardPath: SHARD_PATH,
        log: LOG
    };
    var n3Opts = {
        zfsDataset: PARENT_ZFS_DS + '/' + n3,
        zfsPort: n3Port,
        heartbeatServerPort: ++n3Port,
        mountPoint: FS_PATH_PREFIX + '/' + n3,
        backupPort: ++n3Port,
        postgresPort: ++n3Port,
        cookieLocation: FS_PATH_PREFIX + '/' + n3 + '_metadata' + '/cookie',
        backupServerPort: ++n3Port,
        configLocation: FS_PATH_PREFIX + '/' + n3 + '_metadata' + '/config',
        metadataDir: FS_PATH_PREFIX + '/' + n3 + '_metadata',
        shardPath: SHARD_PATH,
        log: LOG
    };

    vasync.pipeline({funcs: [
        function _createZkClient(_, _cb) {
            mantee_common.createZkClient({
                zk: ZK_URL,
                shard: SHARD_PATH
            }, function (err, zk) {
                ZK_CLIENT = zk;

                return _cb(err);
            });
        },
        function _startN1(_, _cb) {
            var manatee = new Manatee(n1Opts, function (err) {
                if (err) {
                    LOG.error({err: err}, 'could not start manatee');
                    return (_cb);
                }

                MANATEES[manatee.pgUrl] = manatee;
                return _cb();
            });
        },
        function _startN2(_, _cb) {
            var manatee = new Manatee(n2Opts, function (err) {
                if (err) {
                    LOG.error({err: err}, 'could not start manatee');
                    return (_cb);
                }

                MANATEES[manatee.pgUrl] = manatee;
                return _cb();
            });
        },
        function _startN3(_, _cb) {
            var manatee = new Manatee(n3Opts, function (err) {
                if (err) {
                    LOG.error({err: err}, 'could not start manatee');
                    return (_cb);
                }

                MANATEES[manatee.pgUrl] = manatee;
                return _cb();
            });
        }
    ], arg: {}}, function (err, results) {
        if (err) {
            t.fail(err);
        }
        t.done();
    });
};

exports.verifyShard = function (t) {
    vasync.pipeline({funcs: [
        function loadTopology(_, _cb) {
            mantee_common.loadTopology(ZK_CLIENT, function (err, topology) {
                LOG.info({topology: topology});
                LOG.info({shardId: SHARD_ID});
                _.topology = topology[SHARD_ID];
                LOG.info({topology: _.topology});
                if (err) {
                    return _cb(err);
                }
                return _cb();
            });
        },
        function getPgStatus(_, _cb) {
            mantee_common.pgStatus([_.topology], _cb);
        },
        function verifyTopology(_, _cb) {
            /*
             * here we only have to check the sync states of each of the nodes.
             * if the sync states are correct, then we know replication is
             * working.
             */
            t.ok(_.topology, 'shard topology DNE');
            t.ok(_.topology.primary, 'primary DNE');
            t.ok(_.topology.primary.repl, 'no sync repl state');
            t.equal(_.topology.primary.repl.sync_state,
                    'sync',
                    'no sync replication state.');
            t.ok(_.topology.sync, 'sync DNE');
            t.equal(_.topology.sync.repl.sync_state,
                    'async',
                    'no async replication state');
            t.ok(_.topology.async, 'async DNE');
            return _cb();
        }
    ], arg: {}}, function (err, results) {
        if (err) {
            LOG.error({err: err, results: results},
                      'check shard status failed');
                      t.fail(err);
        }
        t.done();
    });
};

//exports.primaryDeath = function (t) {
    //vasync.pipeline({funcs: [
        //function loadTopology(_, _cb) {
            //mantee_common.loadTopology(ZK_CLIENT, function (err, topology) {
                //if (err) {
                    //return _cb(err);
                //}
                //_.topology = topology[SHARD_ID];
                //assert.ok(_.topology);
                //assert.ok(_.topology.primary.pgUrl);
                //_.primaryPgUrl = _.topology.primary.pgUrl;
                //LOG.info({topology: topology}, 'got topology');
                //return _cb();
            //});
        //},
        //function killPrimary(_, _cb) {
            //MANATEES[_.primaryPgUrl].kill(_cb);
        //},
        //function waitForFlip(_, _cb) {
            //setTimeout(_cb, 10000);
        //},
        //function getNewTopology(_, _cb) {
            //mantee_common.loadTopology(ZK_CLIENT, function (err, topology) {
                //if (err) {
                    //return _cb(err);
                //}
                //_.topology = topology[SHARD_ID];
                //assert.ok(_.topology, 'topology DNE');
                //assert.ok(_.topology.primary, 'primary DNE');
                //assert.ok(_.topology.sync, 'sync DNE');
                //assert.equal(_.topology.async, null,
                            //'async should not exist after primary death');
                //LOG.info({topology: topology}, 'got topology');
                //return _cb();
            //});
        //},
        //function getPgStatus(_, _cb) {
            //mantee_common.pgStatus([_.topology], _cb);
        //},
        //function verifyTopology(_, _cb) {
            /*
             * here we only have to check the sync states of each of the nodes.
             * if the sync states are correct, then we know replication is
             * working.
             */
            //t.ok(_.topology, 'shard topology DNE');
            //t.ok(_.topology.primary, 'primary DNE');
            //t.ok(_.topology.primary.repl, 'no sync repl state');
            /*
             * empty repl fields look like this: repl: {}. So we have to check
             * the key length in order to figure out that it is an empty/
             * object.
             */
            //t.equal(Object.keys(_.topology.sync.repl).length, 0,
                    //'sync should not have replication state.');
            //return _cb();
        //},
        //function addNewManatee(_, _cb) {
            //MANATEES[_.primaryPgUrl].start(_cb);
        //},
        //function waitForManateeStart(_, _cb) {
            //setTimeout(_cb, 10000);
        //},
        //function loadTopology2(_, _cb) {
            //mantee_common.loadTopology(ZK_CLIENT, function (err, topology) {
                //_.topology = topology[SHARD_ID];
                //if (err) {
                    //return _cb(err);
                //}
                //LOG.info({topology: topology});
                //return _cb();
            //});
        //},
        //function getPgStatus2(_, _cb) {
            //mantee_common.pgStatus([_.topology], _cb);
        //},
        //function verifyTopology2(_, _cb) {
            /*
             * here we only have to check the sync states of each of the nodes.
             * if the sync states are correct, then we know replication is
             * working.
             */
            //t.ok(_.topology, 'shard topology DNE');
            //t.ok(_.topology.primary, 'primary DNE');
            //t.ok(_.topology.primary.repl, 'no sync repl state');
            //t.equal(_.topology.primary.repl.sync_state,
                    //'sync',
                    //'no sync replication state.');
            //t.ok(_.topology.sync, 'sync DNE');
            //t.equal(_.topology.sync.repl.sync_state,
                    //'async',
                    //'no async replication state');
            //t.ok(_.topology.async, 'async DNE');
            //t.notEqual(_.topology.primary.pgUrl, _.primaryPgUrl,
                           //'primary should not be killed primary');
            //return _cb();
        //}
    //], arg: {}}, function (err, results) {
        //if (err) {
            //t.fail(err);
        //}
        //t.done();
    //});
//};

exports.after = function (t) {
    vasync.pipeline({funcs: [
        //function _cleanupZK(_, _cb) {
            //ZK_CLIENT.rmr('/manatee', _cb);
        //},
        function _stopManatees(_, _cb) {
            var barrier = vasync.barrier();
            barrier.on('drain', function () {
                return _cb();
            });

            Object.keys(MANATEES).forEach(function (m) {
                var id = uuid.v4();
                barrier.start(id);
                MANATEES[m].kill(function () {
                    barrier.done(id);
                });
            });
        },
        function _destroyZfsDataset(_, _cb) {
            console.log('destroying ds');
            exec('zfs destroy -r ' + PARENT_ZFS_DS, _cb);
        },
        function _removeMetadata(_, _cb) {
            exec('rm -rf ' + FS_PATH_PREFIX, _cb);
        },
    ], arg: {}}, function (err, results) {
        LOG.info({err: err, results: err ? results : null}, 'finished after()');
        t.done();
    });
};
