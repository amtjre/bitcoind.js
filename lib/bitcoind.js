/**
 * bitcoind.js
 * Copyright (c) 2014, BitPay (MIT License)
 * A bitcoind node.js binding.
 */

var net = require('net');
var EventEmitter = require('events').EventEmitter;
var bitcoindjs = require('../build/Release/bitcoindjs.node');
var util = require('util');
var fs = require('fs');
var mkdirp = require('mkdirp');
var tiny = require('tiny').json;

// Compatibility with old node versions:
var setImmediate = global.setImmediate || process.nextTick.bind(process);

/**
 * Bitcoin
 */

var bitcoin = Bitcoin;

function Bitcoin(options) {
  var self = this;

  if (!(this instanceof Bitcoin)) {
    return new Bitcoin(options);
  }

  if (Object.keys(this.instances).length) {
    throw new
      Error('bitcoind.js cannot be instantiated more than once.');
  }

  EventEmitter.call(this);

  this.options = options || {};
  this.wallet = Wallet;

  if (typeof this.options === 'string') {
    this.options = { datadir: this.options };
  }

  if (this.options.directory) {
    this.options.datadir = this.options.directory;
    delete this.options.directory;
  }

  if (!this.options.datadir) {
    this.options.datadir = '~/.bitcoind.js';
  }

  this.options.datadir = this.options.datadir.replace(/^~/, process.env.HOME);

  this.datadir = this.options.datadir;
  this.config = this.datadir + '/bitcoin.conf';
  this.network = Bitcoin[this.options.testnet ? 'testnet' : 'livenet'];

  if (!fs.existsSync(this.datadir)) {
    mkdirp.sync(this.datadir);
  }

  if (!fs.existsSync(this.config)) {
    var password = ''
      + Math.random().toString(36).slice(2)
      + Math.random().toString(36).slice(2)
      + Math.random().toString(36).slice(2);
    fs.writeFileSync(this.config, ''
      + 'rpcuser=bitcoinrpc\n'
      + 'rpcpassword=' + password + '\n'
    );
  }

  // Add hardcoded peers
  var data = fs.readFileSync(this.config, 'utf8');
  if (this.network.peers.length) {
    var peers = this.network.peers.reduce(function(out, peer) {
      if (!~data.indexOf('addnode=' + peer)) {
        return out + 'addnode=' + peer + '\n';
      }
      return out;
    }, '\n');
    fs.writeFileSync(data + peers);
  }

  // Copy config into testnet dir
  if (this.network.name === 'testnet') {
    if (!fs.existsSync(this.datadir + '/testnet3')) {
      fs.mkdirSync(this.datadir + '/testnet3');
    }
    fs.writeFileSync(
      this.datadir + '/testnet3/bitcoin.conf',
      fs.readFileSync(this.config));
  }

  Object.keys(exports).forEach(function(key) {
    self[key] = exports[key];
  });

  this.on('newListener', function(name) {
    if (name === 'open') {
      self.start();
    }
  });
}

Bitcoin.prototype.__proto__ = EventEmitter.prototype;

Bitcoin.livenet = {
  name: 'livenet',
  peers: [
    // hardcoded peers
  ]
};

Bitcoin.testnet = {
  name: 'testnet',
  peers: [
    // hardcoded peers
  ]
};

// Make sure signal handlers are not overwritten
Bitcoin._signalQueue = [];
Bitcoin._processOn = process.on;
process.addListener =
process.on = function(name, listener) {
  if (~['SIGINT', 'SIGHUP', 'SIGQUIT'].indexOf(name.toUpperCase())) {
    if (!Bitcoin.global || !Bitcoin.global._started) {
      Bitcoin._signalQueue.push([name, listener]);
      return;
    }
  }
  return Bitcoin._processOn.apply(this, arguments);
};

Bitcoin.instances = {};
Bitcoin.prototype.instances = Bitcoin.instances;

Bitcoin.__defineGetter__('global', function() {
  if (bitcoin.stopping) return [];
  return Bitcoin.instances[Object.keys(Bitcoin.instances)[0]];
});

Bitcoin.prototype.__defineGetter__('global', function() {
  if (bitcoin.stopping) return [];
  return Bitcoin.global;
});

tiny.debug = function() {};
tiny.prototype.debug = function() {};
tiny.error = function() {};
tiny.prototype.error = function() {};

Bitcoin.db = tiny({
  file: process.env.HOME + '/.bitcoindjs.db',
  saveIndex: false,
  initialCache: false
});

Bitcoin.prototype.start = function(options, callback) {
  var self = this;

  if (!callback) {
    callback = options;
    options = null;
  }

  if (!options) {
    options = {};
  }

  if (!callback) {
    callback = utils.NOOP;
  }

  if (this.instances[this.datadir]) {
    return;
  }
  this.instances[this.datadir] = true;

  var none = {};
  var isSignal = {};
  var sigint = { name: 'SIGINT', signal: isSignal };
  var sighup = { name: 'SIGHUP', signal: isSignal };
  var sigquit = { name: 'SIGQUIT', signal: isSignal };
  var exitCaught = none;
  var errorCaught = none;

  Object.keys(this.options).forEach(function(key) {
    if (options[key] == null) {
      options[key] = self.options[key];
    }
  });

  // XXX -txindex currently causes a segfault during blockchain download
  // if (options.txindex !== false) {
  //   options.txindex = true;
  // }

  bitcoindjs.start(options, function(err, status) {
    self._started = true;

    // Poll for queued packets
    setInterval(function() {
      var packets = bitcoindjs.hookPackets();

      if (!packets) {
        if (self.debug) {
          self.error('Error polling packet queue.');
        }
        return;
      }

      if (!packets.length) {
        return;
      }

      self.emit('_packets', packets);

      packets.forEach(function(packet) {
        setImmediate(function() {
          self.emit('raw:' + packet.name, packet);
          self.emit('raw', packet);

          if (packet.name === 'addr') {
            self.emit(packet.name, packet.addresses);
            self.emit('digest', packet.addresses);
            return;
          }

          if (packet.name === 'block') {
            var block = self.block(packet.block);
            self.emit(packet.name, block);
            self.emit('digest', block);
            block.tx.forEach(function(tx) {
              setImmediate(function() {
                tx = self.tx(tx);
                self.emit('tx', tx);
                self.emit('digest', tx);
              });
            });
            return;
          }

          if (packet.name === 'tx') {
            var tx = self.tx(packet.tx);
            var name = packet.name;
            if (!packet.tx.blockhash) {
              name = 'mptx';
            }
            self.emit(name, tx);
            self.emit('digest', tx);
            return;
          }

          self.emit(packet.name, packet);
          self.emit('digest', packet);
        });
      });
    }, 50);

    [sigint, sighup, sigquit].forEach(function(signal) {
      process.on(signal.name, signal.listener = function() {
        if (process.listeners(signal.name).length > 1) {
          return;
        }
        if (!self._shutdown) {
          process.exit(0);
        } else {
          self.stop();
          exitCaught = signal;
        }
      });
    });

    // Finally set signal handlers
    process.on = process.addListener = Bitcoin._processOn;
    Bitcoin._signalQueue.forEach(function(event) {
      process.on(event[0], event[1]);
    });

    var exit = process.exit;
    self._exit = function() {
      return exit.apply(process, arguments);
    };

    process.exit = function(code) {
      exitCaught = code || 0;
      if (!self._shutdown) {
        return self._exit(code);
      }
      self.stop();
    };

    process.on('uncaughtException', function(err) {
      if (process.listeners('uncaughtException').length > 1) {
        return;
      }
      errorCaught = err;
      self.error('Uncaught error: shutting down safely before throwing...');
      if (!self._shutdown) {
        if (err && err.stack) {
          console.error(err.stack);
        }
        self._exit(1);
        return;
      }
      self.stop();
    });

    setTimeout(function callee() {
      // Wait until wallet is loaded:
      if (!Object.keys(self.wallet.listAccounts()).length) {
        return setTimeout(callee, 100);
      }

      if (callback) {
        callback(err ? err : null);
      }

      if (err) {
        self.emit('error', err);
      } else {
        if (callback) {
          self.emit('open', status);
        } else {
          self.emit('status', status);
        }
      }

      if (callback) {
        callback = null;
      }
    }, 100);
  });

  // bitcoind's boost threads aren't in the thread pool
  // or on node's event loop, so we need to keep node open.
  this._shutdown = setInterval(function() {
    if (!self._stoppingSaid && bitcoindjs.stopping()) {
      self._stoppingSaid = true;
      self.log('shutting down...');
    }

    if (bitcoindjs.stopped()) {
      self.log('shut down.');

      clearInterval(self._shutdown);
      delete self._shutdown;

      if (exitCaught !== none) {
        if (exitCaught.signal === isSignal) {
          process.removeListener(exitCaught.name, exitCaught.listener);
          setImmediate(function() {
            process.kill(process.pid, exitCaught.name);
          });
          return;
        }
        return self._exit(exitCaught);
      }

      if (errorCaught !== none) {
        if (errorCaught && errorCaught.stack) {
          console.error(errorCaught.stack);
        }
        return self._exit(0);
      }
    }
  }, 1000);
};

Bitcoin.prototype.getBlock = function(blockhash, callback) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.getBlock(blockhash, function(err, block) {
    if (err) return callback(err);
    return callback(null, bitcoin.block(block));
  });
};

Bitcoin.prototype.getBlockHeight = function(height, callback) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.getBlock(+height, function(err, block) {
    if (err) return callback(err);
    return callback(null, bitcoin.block(block));
  });
};

Bitcoin.prototype.getTransaction =
Bitcoin.prototype.getTx = function(txid, blockhash, callback) {
  if (bitcoin.stopping) return [];
  if (typeof txid === 'object' && txid) {
    var options = txid;
    callback = blockhash;
    txid = options.txid || options.tx || options.txhash || options.id || options.hash;
    blockhash = options.blockhash || options.block;
  }

  if (typeof blockhash === 'function') {
    callback = blockhash;
    blockhash = '';
  }

  if (typeof blockhash !== 'string') {
    if (blockhash) {
      blockhash = blockhash.hash
        || blockhash.blockhash
        || (blockhash.getHash && blockhash.getHash())
        || '';
    } else {
      blockhash = '';
    }
  }

  return bitcoindjs.getTransaction(txid, blockhash, function(err, tx) {
    if (err) return callback(err);
    return callback(null, bitcoin.tx(tx));
  });
};

Bitcoin.prototype.getTransactionWithBlock = function(txid, blockhash, callback) {
  if (bitcoin.stopping) return [];

  var self = this;
  var slow = true;

  if (typeof txid === 'object' && txid) {
    var options = txid;
    callback = blockhash;
    txid = options.txid || options.tx || options.txhash || options.id || options.hash;
    blockhash = options.blockhash || options.block;
    slow = options.slow !== false;
  }

  if (typeof blockhash === 'function') {
    callback = blockhash;
    blockhash = '';
  }

  if (typeof blockhash !== 'string') {
    if (blockhash) {
      blockhash = blockhash.hash
        || blockhash.blockhash
        || (blockhash.getHash && blockhash.getHash())
        || '';
    } else {
      blockhash = '';
    }
  }

  return bitcoindjs.getTransaction(txid, blockhash, function(err, tx) {
    if (err) return callback(err);

    if (slow && !tx.blockhash) {
      return self.getBlockByTx(txid, function(err, block, tx_) {
        if (err) return callback(err);
        return callback(null, tx, block);
      });
    }

    return bitcoindjs.getBlock(tx.blockhash, function(err, block) {
      if (err) return callback(err);
      return callback(null, bitcoin.tx(tx), bitcoin.block(block));
    });
  });
};

Bitcoin.prototype.getInfo = function() {
  if (bitcoin.stopping) return [];
  return bitcoindjs.getInfo();
};

Bitcoin.prototype.getPeerInfo = function() {
  if (bitcoin.stopping) return [];
  return bitcoindjs.getPeerInfo();
};

Bitcoin.prototype.getAddresses = function() {
  if (bitcoin.stopping) return [];
  return bitcoindjs.getAddresses();
};

Bitcoin.prototype.getProgress = function(callback) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.getProgress(callback);
};

Bitcoin.prototype.setGenerate = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.setGenerate(options || {});
};

Bitcoin.prototype.getGenerate = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.getGenerate(options || {});
};

Bitcoin.prototype.getMiningInfo = function() {
  if (bitcoin.stopping) return [];
  return bitcoindjs.getMiningInfo();
};

Bitcoin.prototype.getAddrTransactions = function(address, callback) {
  if (bitcoin.stopping) return [];
  return bitcoin.db.get('addr-tx/' + address, function(err, records) {
    var options = {
      address: address,
      blockheight: (records || []).reduce(function(out, record) {
        return record.blockheight > out
          ? record.blockheight
          : out;
      }, -1),
      blocktime: (records || []).reduce(function(out, record) {
        return record.blocktime > out
          ? record.blocktime
          : out;
      }, -1)
    };
    return bitcoindjs.getAddrTransactions(options, function(err, addr) {
      if (err) return callback(err);
      addr = bitcoin.addr(addr);
      if (addr.tx[0] && !addr.tx[0].vout[0]) {
        return bitcoin.db.set('addr-tx/' + address, [{
          txid: null,
          blockhash: null,
          blockheight: null,
          blocktime: null
        }], function() {
          return callback(null, bitcoin.addr({
            address: addr.address,
            tx: []
          }));
        });
      }
      var set = [];
      if (records && records.length) {
        set = records;
      }
      addr.tx.forEach(function(tx) {
        set.push({
          txid: tx.txid,
          blockhash: tx.blockhash,
          blockheight: tx.blockheight,
          blocktime: tx.blocktime
        });
      });
      return bitcoin.db.set('addr-tx/' + address, set, function() {
        return callback(null, addr);
      });
    });
  });
};

Bitcoin.prototype.getBestBlock = function(callback) {
  if (bitcoin.stopping) return [];
  var hash = bitcoindjs.getBestBlock();
  return bitcoindjs.getBlock(hash, callback);
};

Bitcoin.prototype.getChainHeight = function() {
  if (bitcoin.stopping) return [];
  return bitcoindjs.getChainHeight();
};

Bitcoin.prototype.__defineGetter__('chainHeight', function() {
  if (bitcoin.stopping) return [];
  return this.getChainHeight();
});

Bitcoin.prototype.getBlockByTxid =
Bitcoin.prototype.getBlockByTx = function(txid, callback) {
  if (bitcoin.stopping) return [];
  return bitcoin.db.get('block-tx/' + txid, function(err, block) {
    if (block) {
      return self.getBlock(block.hash, function(err, block) {
        if (err) return callback(err);
        var tx_ = block.tx.filter(function(tx) {
          return tx.txid === txid;
        })[0];
        return callback(null, block, tx_);
      });
    }
    return bitcoindjs.getBlockByTx(txid, function(err, block, tx_) {
      if (err) return callback(err);
      bitcoin.db.set('block-tx/' + txid, { hash: block.hash }, utils.NOOP);
      return callback(null, bitcoin.block(block), bitcoin.tx(tx_));
    });
  });
};

Bitcoin.prototype.getBlocksByDate =
Bitcoin.prototype.getBlocksByTime = function(options, callback) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.getBlocksByTime(options, function(err, blocks) {
    if (err) return callback(err);
    return callback(null, blocks.map(function(block) {
      return bitcoin.block(block)
    }));
  });
};

Bitcoin.prototype.getFromTx = function(txid, callback) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.getFromTx(txid, function(err, txs) {
    if (err) return callback(err);
    return callback(null, txs.map(function(tx) {
      return bitcoin.tx(tx)
    }));
  });
};

Bitcoin.prototype.getLastFileIndex = function() {
  if (bitcoin.stopping) return [];
  return bitcoindjs.getLastFileIndex();
};

Bitcoin.prototype.log =
Bitcoin.prototype.info = function() {
  if (bitcoin.stopping) return [];
  if (this.options.silent) return;
  if (typeof arguments[0] !== 'string') {
    var out = util.inspect(arguments[0], null, 20, true);
    return process.stdout.write('bitcoind.js: ' + out + '\n');
  }
  var out = util.format.apply(util, arguments);
  return process.stdout.write('bitcoind.js: ' + out + '\n');
};

Bitcoin.prototype.error = function() {
  if (bitcoin.stopping) return [];
  if (this.options.silent) return;
  if (typeof arguments[0] !== 'string') {
    var out = util.inspect(arguments[0], null, 20, true);
    return process.stderr.write('bitcoind.js: ' + out + '\n');
  }
  var out = util.format.apply(util, arguments);
  return process.stderr.write('bitcoind.js: ' + out + '\n');
};

Bitcoin.prototype.stop =
Bitcoin.prototype.close = function(callback) {
  if (bitcoin.stopping) return [];
  var self = this;
  return bitcoindjs.stop(function(err, status) {
    if (err) {
      self.error(err.message);
    } else {
      self.log(status);
    }
    if (!callback) return;
    return callback(err, status);
  });
};

Bitcoin.prototype.__defineGetter__('stopping', function() {
  return bitcoindjs.stopping() || bitcoindjs.stopped();
});

Bitcoin.prototype.__defineGetter__('stopped', function() {
  return bitcoindjs.stopped();
});

Bitcoin.__defineGetter__('stopping', function() {
  return bitcoindjs.stopping() || bitcoindjs.stopped();
});

Bitcoin.__defineGetter__('stopped', function() {
  return bitcoindjs.stopped();
});

/**
 * Block
 */

function Block(data) {
  if (!(this instanceof Block)) {
    return new Block(data);
  }

  if (typeof data === 'string') {
    return Block.fromHex(data);
  }

  if (data instanceof Block) {
    return data;
  }

  if (bitcoin.stopping) return [];

  var self = this;

  Object.keys(data).forEach(function(key) {
    if (!self[key]) {
      self[key] = data[key];
    }
  });

  this.tx = this.tx.map(function(tx) {
    return bitcoin.tx(tx);
  });

  if (!this.hex) {
    this.hex = this.toHex();
  }
}

Object.defineProperty(Block.prototype, '_blockFlag', {
  __proto__: null,
  configurable: false,
  enumerable: false,
  writable: false,
  value: {}
});

Block.isBlock = function(block) {
  if (bitcoin.stopping) return [];
  return block._blockFlag === Block.prototype._blockFlag;
};

Block.fromHex = function(hex) {
  if (bitcoin.stopping) return [];
  return bitcoin.block(bitcoindjs.blockFromHex(hex));
};

Block.prototype.getHash = function(enc) {
  if (bitcoin.stopping) return [];
  var data = bitcoindjs.getBlockHex(this);
  if (!this.hash || this.hash !== data.hash) {
    this.hash = data.hash;
  }
  if (enc === 'hex') return data.hash;
  var buf = new Buffer(data.hash, 'hex');
  var out = enc ? buf.toString(enc) : buf;
  return out;
};

Block.prototype.verify = function() {
  if (bitcoin.stopping) return [];
  return this.verified = this.verified || bitcoindjs.verifyBlock(this);
};

Block.prototype.toHex = function() {
  if (bitcoin.stopping) return [];
  var hex = Block.toHex(this);
  if (!this.hex || this.hex !== hex) {
    this.hex = hex;
  }
  return hex;
};

Block.toHex = function(block) {
  if (bitcoin.stopping) return [];
  var data = bitcoindjs.getBlockHex(block);
  return data.hex;
};

Block.prototype.toBinary = function() {
  if (bitcoin.stopping) return [];
  return Block.toBinary(this);
};

Block.toBinary = function(block) {
  if (bitcoin.stopping) return [];
  var data = bitcoindjs.getBlockHex(block);
  return new Buffer(data.hex, 'hex');
};

/**
 * Transaction
 */

function Transaction(data) {
  if (!(this instanceof Transaction)) {
    return new Transaction(data);
  }

  if (typeof data === 'string') {
    return Transaction.fromHex(data);
  }

  if (data instanceof Transaction) {
    return data;
  }

  if (bitcoin.stopping) return [];

  var self = this;

  Object.keys(data).forEach(function(key) {
    if (!self[key]) {
      self[key] = data[key];
    }
  });

  if (!this.hex) {
    this.hex = this.toHex();
  }
}

Object.defineProperty(Transaction.prototype, '_txFlag', {
  __proto__: null,
  configurable: false,
  enumerable: false,
  writable: false,
  value: {}
});

Transaction.isTransaction =
Transaction.isTx = function(tx) {
  if (bitcoin.stopping) return [];
  return tx._txFlag === Transaction.prototype._txFlag;
};

Transaction.fromHex = function(hex) {
  if (bitcoin.stopping) return [];
  return bitcoin.tx(bitcoindjs.txFromHex(hex));
};

Transaction.prototype.verify = function() {
  if (bitcoin.stopping) return [];
  return this.verified = this.verified || bitcoindjs.verifyTransaction(this);
};

Transaction.prototype.sign =
Transaction.prototype.fill = function(options) {
  if (bitcoin.stopping) return [];
  return Transaction.fill(this, options);
};

Transaction.sign =
Transaction.fill = function(tx, options) {
  if (bitcoin.stopping) return [];
  var isTx = bitcoin.tx.isTx(tx)
    , newTx;

  if (!isTx) {
    tx = bitcoin.tx(tx);
  }

  try {
    newTx = bitcoindjs.fillTransaction(tx, options || {});
  } catch (e) {
    return false;
  }

  Object.keys(newTx).forEach(function(key) {
    tx[key] = newTx[key];
  });

  return tx;
};

Transaction.prototype.getHash = function(enc) {
  if (bitcoin.stopping) return [];
  var data = bitcoindjs.getTxHex(this);
  if (!this.txid || this.txid !== data.hash) {
    this.txid = data.hash;
  }
  if (enc === 'hex') return data.hash;
  var buf = new Buffer(data.hash, 'hex');
  var out = enc ? buf.toString(enc) : buf;
  return out;
};

Transaction.prototype.isCoinbase = function() {
  if (bitcoin.stopping) return [];
  return this.vin.length === 1 && this.vin[0].coinbase;
};

Transaction.prototype.toHex = function() {
  if (bitcoin.stopping) return [];
  var hex = Transaction.toHex(this);
  if (!this.hex || hex !== this.hex) {
    this.hex = hex;
  }
  return hex;
};

Transaction.toHex = function(tx) {
  if (bitcoin.stopping) return [];
  var data = bitcoindjs.getTxHex(tx);
  return data.hex;
};

Transaction.prototype.toBinary = function() {
  if (bitcoin.stopping) return [];
  return Transaction.toBinary(this);
};

Transaction.toBinary = function(tx) {
  if (bitcoin.stopping) return [];
  var data = bitcoindjs.getTxHex(tx);
  return new Buffer(data.hex, 'hex');
};

Transaction.broadcast = function(tx, options, callback) {
  if (bitcoin.stopping) return [];
  if (typeof tx === 'string') {
    tx = { hex: tx };
  }

  if (!callback) {
    callback = options;
    options = null;
  }

  if (!options) {
    options = {};
  }

  var fee = options.overrideFees = options.overrideFees || false;
  var own = options.ownOnly = options.ownOnly || false;

  if (!callback) {
    callback = utils.NOOP;
  }

  if (!bitcoin.isTx(tx)) {
    tx = bitcoin.tx(tx);
  }

  return bitcoindjs.broadcastTx(tx, fee, own, function(err, hash, tx) {
    if (err) {
      if (callback === utils.NOOP) {
        bitcoin.global.emit('error', err);
      }
      return callback(err);
    }
    tx = bitcoin.tx(tx);
    bitcoin.global.emit('broadcast', tx);
    return callback(null, hash, tx);
  });
};

Transaction.prototype.broadcast = function(options, callback) {
  if (bitcoin.stopping) return [];
  if (!callback) {
    callback = options;
    options = null;
  }
  return Transaction.broadcast(this, options, callback);
};

/**
 * Addresses
 */

function Addresses(data) {
  if (!(this instanceof Addresses)) {
    return new Addresses(data);
  }

  if (data instanceof Addresses) {
    return data;
  }

  if (bitcoin.stopping) return [];

  var self = this;

  Object.keys(data).forEach(function(key) {
    if (!self[key]) {
      self[key] = data[key];
    }
  });
}

Object.defineProperty(Transaction.prototype, '_addrFlag', {
  __proto__: null,
  configurable: false,
  enumerable: false,
  writable: false,
  value: {}
});

Addresses.isAddresses =
Addresses.isAddr = function(addr) {
  if (bitcoin.stopping) return [];
  return addr._txFlag === Addresses.prototype._addrFlag;
};

/**
 * Wallet
 * Singleton
 */

function Wallet() {
  if (bitcoin.stopping) return [];
  var obj = function() {
    return obj;
  };
  Object.keys(Wallet.prototype).forEach(function(key) {
    obj[key] = Wallet.prototype[key];
  });
  return obj;
}

Wallet.prototype.createAddress = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletNewAddress(options || {});
};

Wallet.prototype.getAccountAddress = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletGetAccountAddress(options || {});
};

Wallet.prototype.setAccount = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletSetAccount(options || {});
};

Wallet.prototype.getAccount = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletGetAccount(options || {});
};

Wallet.prototype.getRecipients = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletGetRecipients(options || {});
};

Wallet.prototype.getRecipient = function(options) {
  if (bitcoin.stopping) return [];
  options = options || {};
  var label = options.label || label;
  return bitcoindjs.walletGetRecipients({ _label: label });
};

Wallet.prototype.setRecipient = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletSetRecipient(options || {});
};

Wallet.prototype.removeRecipient = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletRemoveRecipient(options || {});
};

Wallet.prototype.sendTo = function(options, callback) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletSendTo(options || {}, callback);
};

Wallet.prototype.sendFrom = function(options, callback) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletSendFrom(options || {}, callback);
};

Wallet.prototype.move = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletMove(options || {});
};

Wallet.prototype.signMessage = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletSignMessage(options || {});
};

Wallet.prototype.verifyMessage = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletVerifyMessage(options || {});
};

Wallet.prototype.createMultiSigAddress = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletCreateMultiSigAddress(options || {});
};

Wallet.prototype.getBalance = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletGetBalance(options || {});
};

Wallet.prototype.getUnconfirmedBalance = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletGetUnconfirmedBalance(options || {});
};

// XXX Wallet Transactions
Wallet.prototype.listTransactions =
Wallet.prototype.getTransactions = function(options, callback) {
  if (bitcoin.stopping) return [];
  var txs = bitcoindjs.walletListTransactions(options || {});
  if (callback) {
    // Retrieve to regular TXs from disk:
    var out = [];
    return utils.forEach(txs, function(tx, next) {
      return bitcoindjs.getTransaction(tx.txid, tx.blockhash, function(err, tx_) {
        if (err) return next(err);
        var tx = bitcoin.tx(tx_);
        tx._walletTransaction = tx_;
        out.push(tx);
        return next();
      });
    }, function(err) {
      if (err) return callback(err);
      return callback(null, out);
    });
  }
  return txs;
};

Wallet.prototype.listReceivedByAddress =
Wallet.prototype.getReceivedByAddress = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletReceivedByAddress(options || {});
};

Wallet.prototype.listAccounts =
Wallet.prototype.getAccounts = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletListAccounts(options || {});
};

// XXX Wallet Transaction
Wallet.prototype.getTransaction = function(options, callback) {
  if (bitcoin.stopping) return [];
  var tx = bitcoindjs.walletGetTransaction(options || {});
  if (callback) {
    // Retrieve to regular TX from disk:
    return bitcoindjs.getTransaction(tx.txid, tx.blockhash, function(err, tx_) {
      if (err) return next(err);
      var tx = bitcoin.tx(tx_);
      tx._walletTransaction = tx_;
      return callback(null, tx);
    });
  }
  return tx;
};

Wallet.prototype.backup = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletBackup(options || {});
};

Wallet.prototype.decrypt =
Wallet.prototype.passphrase = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletPassphrase(options || {});
};

Wallet.prototype.passphraseChange = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletPassphraseChange(options || {});
};

Wallet.prototype.forgetPassphrase =
Wallet.prototype.lock = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletLock(options || {});
};

Wallet.prototype.encrypt = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletEncrypt(options || {});
};

Wallet.prototype.encrypted = function() {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletEncrypted();
};

Wallet.prototype.isEncrypted = function() {
  if (bitcoin.stopping) return false;
  return this.encrypted().encrypted;
};

Wallet.prototype.isLocked = function() {
  if (bitcoin.stopping) return false;
  return this.encrypted().locked;
};

Wallet.prototype.dumpKey = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletDumpKey(options || {});
};

Wallet.prototype.importKey = function(options, callback) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletImportKey(options || {}, callback);
};

Wallet.prototype.keyPoolRefill = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletKeyPoolRefill(options || {});
};

Wallet.prototype.setTxFee = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletSetTxFee(options || {});
};

Wallet.prototype.dump = function(options, callback) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletDumpWallet(options || {}, callback);
};

Wallet.prototype.import = function(options, callback) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletImportWallet(options || {}, callback);
};

Wallet.prototype.changeLabel = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletChangeLabel(options || {});
};

Wallet.prototype.deleteAccount = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletDeleteAccount(options || {});
};

Wallet.prototype.isMine = function(options) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletIsMine(options || {});
};

Wallet.prototype.rescan = function(options, callback) {
  if (bitcoin.stopping) return [];
  return bitcoindjs.walletRescan(options || {}, callback);
};

Wallet = new Wallet;

/**
 * Utils
 */

var utils = {};

utils.forEach = function(obj, iter, done) {
  if (bitcoin.stopping) return [];
  var pending = obj.length;
  if (!pending) return done();
  var next = function() {
    if (!--pending) done();
  };
  obj.forEach(function(item) {
    iter(item, next);
  });
};

utils.NOOP = function() {};

/**
 * Expose
 */

module.exports = exports = bitcoin;

exports.Bitcoin = bitcoin;
exports.bitcoin = bitcoin;
exports.bitcoind = bitcoin;

exports.native = bitcoindjs;
exports.bitcoindjs = bitcoindjs;

exports.Block = Block;
exports.block = Block;

exports.Transaction = Transaction;
exports.transaction = Transaction;
exports.tx = Transaction;

exports.Addresses = Addresses;
exports.addresses = Addresses;
exports.addr = Addresses;

exports.Wallet = Wallet;
exports.wallet = Wallet;

exports.utils = utils;
