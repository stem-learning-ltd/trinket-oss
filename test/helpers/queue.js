var sinon   = require('sinon'),
    queues  = require('../../lib/util/queues'),
    snapshotQueue = queues.snapshots ? queues.snapshots() : queues.exports();

module.exports = {
  snapshotQueue : snapshotQueue,
  stub : function() {
    before(function() {
      sinon.stub(snapshotQueue, 'add', function(data) {
        return {
          then : function(f) {
            f();
          }
        };
      });
    });

    after(function() {
      snapshotQueue.add.restore();
    });
  }
};
