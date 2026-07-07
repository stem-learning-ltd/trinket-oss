var config = require('config');

// Check if Redis is enabled
var redisEnabled = config.db && config.db.redis && config.db.redis.enabled !== false;

// In-memory queue implementation for when Redis is not available
function InMemoryQueue(name) {
  this.name = name;
  this.handlers = [];
  this.processing = false;
  this.jobs = [];
}

InMemoryQueue.prototype.process = function(handler) {
  this.handlers.push(handler);
};

InMemoryQueue.prototype.add = function(data, opts) {
  var self = this;
  var job = {
    id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
    data: data,
    opts: opts || {},
    attempts: 0
  };

  // Process immediately in next tick (simulates async queue behavior)
  setImmediate(function() {
    self._processJob(job);
  });

  return Promise.resolve(job);
};

InMemoryQueue.prototype._processJob = function(job) {
  var self = this;

  if (this.handlers.length === 0) {
    // No handlers registered, job is essentially dropped
    // This is fine for optional features like analytics/events
    return;
  }

  // Call all handlers
  this.handlers.forEach(function(handler) {
    try {
      var result = handler(job, function done(err) {
        if (err) {
          console.log('InMemoryQueue [' + self.name + '] job failed:', err.message);
        }
      });

      // Handle promise-based handlers
      if (result && typeof result.catch === 'function') {
        result.catch(function(err) {
          console.log('InMemoryQueue [' + self.name + '] job failed:', err.message);
        });
      }
    } catch (err) {
      console.log('InMemoryQueue [' + self.name + '] job error:', err.message);
    }
  });
};

InMemoryQueue.prototype.on = function(event, handler) {
  // No-op for compatibility - in-memory queue doesn't emit events
  return this;
};

InMemoryQueue.prototype.close = function() {
  return Promise.resolve();
};

// No-op queue for features that are disabled
function NoOpQueue(name) {
  this.name = name;
}

NoOpQueue.prototype.process = function() {};
NoOpQueue.prototype.add = function() { return Promise.resolve({ id: 'noop' }); };
NoOpQueue.prototype.on = function() { return this; };
NoOpQueue.prototype.close = function() { return Promise.resolve(); };

// Queue cache
var cache = {};

// List of queues that should be completely disabled (no-op)
var disabledQueues = ['receipts', 'reports', 'containers', 'notifier', 'events', 'snapshots', 'courses', 'trinkets', 'folders'];

// Create queue factory
function createQueue(name) {
  if (cache[name]) {
    return cache[name];
  }

  // Check if this queue is disabled
  if (disabledQueues.indexOf(name) >= 0) {
    console.log('Queue [' + name + '] is disabled, using no-op queue');
    cache[name] = new NoOpQueue(name);
    return cache[name];
  }

  // Use Bull if Redis is enabled
  if (redisEnabled) {
    var Queue = require('bull');
    var queueConfig = config.db.redis[name] || config.db.redis.app;
    var opts = {};

    opts.redis = {
      host: queueConfig.host,
      port: queueConfig.port
    };
    // ioredis resolves IPv4-only by default (family: 4). IPv6-only hosts
    // (e.g. Fly private networking) need family set to 6 in config.
    if (queueConfig.family) {
      opts.redis.family = queueConfig.family;
    }
    if (queueConfig.password) {
      opts.redis.password = queueConfig.password;
    }

    cache[name] = new Queue(name, opts);
    // Without an error listener, one transient Redis error (DNS flap,
    // reconnect) is an unhandled 'error' event and kills the process.
    // ioredis retries the connection itself; logging is all we need here.
    cache[name].on('error', function(err) {
      console.log('Queue [' + name + '] redis error:', err.message);
    });
    console.log('Queue [' + name + '] using Bull with Redis');
  } else {
    // Use in-memory queue
    cache[name] = new InMemoryQueue(name);
    console.log('Queue [' + name + '] using in-memory queue (Redis not configured)');
  }

  return cache[name];
}

// Export queue getters for each queue type
var bullqueues = config.db && config.db.redis && config.db.redis.bullqueues
  ? config.db.redis.bullqueues
  : ['exports'];

bullqueues.forEach(function(queueName) {
  module.exports[queueName] = function() {
    return createQueue(queueName);
  };
});

// Export utilities
module.exports.isRedisEnabled = function() {
  return redisEnabled;
};

module.exports.closeAll = function() {
  var promises = Object.keys(cache).map(function(name) {
    return cache[name].close();
  });
  return Promise.all(promises);
};
