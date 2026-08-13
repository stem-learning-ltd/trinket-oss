// Load app.js before config/db so that @hapi/hapi and its deps (including @hapi/shot and
// @hapi/inert) are cached before mongoose-schema-extend loads harmony-reflect, which
// patches Proxy in a way that breaks @hapi/validate's plain-object check at schema build time.
require('../../app.js');

var _            = require('underscore'),
    db           = require('../../config/db'),
    mongoose     = require('mongoose'),
    initializing = true,
    instance;

function DB() {
  this._isConnected = false;
  _.bindAll(this, 'ensureConnection', 'reset');
}

_.extend(DB.prototype, {
  ensureConnection : function(done) {
    var self = this;

    if (self.isConnected()) return done && done();

    (function wait() {
      if (self.isConnected()) {
        return done && done();
      }
      setTimeout(wait, 0);
    })();
  },

  reset : function(done) {
    if (!this.isConnected()) return done && done();

    mongoose.connection.db.dropDatabase(function() {
      done && done();
    });
  },

  isConnected : function() {
    return this._isConnected;
  }
});

instance = new DB();

function checkState() {
  switch(mongoose.connection.readyState) {
    case 0:
      console.log('mongoose connection died, reconnecting...');
      db.connect();
    case 1:
      // if initializing, clear the db
      if (initializing) {
        initializing = false;
        mongoose.connection.db.dropDatabase(function() {
          instance._isConnected = true;
        });
      }
      else {
        instance._isConnected = true;
      }
      
      break;
    default:
      setTimeout(checkState, 0);
  }
}

checkState();

module.exports = instance;
