var expect   = require('chai').expect;
var SenseHat = require('../../../public/js/embed/sense_hat.js');

describe('SenseHat.makeStick', function() {
  it('starts with an empty queue and null thread handler', function() {
    var s = SenseHat.makeStick();
    expect(s._eventQueue).to.deep.equal([]);
    expect(s._threadHandler).to.equal(null);
  });

  it('emit calls on() handlers with (eventName, data)', function() {
    var s = SenseHat.makeStick();
    var calls = [];
    s.on('sensestick.input', function(evt, data) { calls.push([evt, data]); });
    s.emit('sensestick.input', { type: 'keydown' });
    expect(calls).to.deep.equal([['sensestick.input', { type: 'keydown' }]]);
  });

  it('once fires only a single time', function() {
    var s = SenseHat.makeStick();
    var n = 0;
    s.once('sensestick.input', function() { n++; });
    s.emit('sensestick.input', {});
    s.emit('sensestick.input', {});
    expect(n).to.equal(1);
  });

  it('off removes a handler registered with on', function() {
    var s = SenseHat.makeStick();
    var n = 0;
    function h() { n++; }
    s.on('sensestick.input', h);
    s.off('sensestick.input', h);
    s.emit('sensestick.input', {});
    expect(n).to.equal(0);
  });

  it('off removes a handler registered with once (by original fn)', function() {
    var s = SenseHat.makeStick();
    var n = 0;
    function h() { n++; }
    s.once('sensestick.input', h);
    s.off('sensestick.input', h);
    s.emit('sensestick.input', {});
    expect(n).to.equal(0);
  });
});

describe('SenseHat.keyToDirection', function() {
  it('maps arrow keys and Enter to directions', function() {
    expect(SenseHat.keyToDirection('ArrowUp')).to.equal('up');
    expect(SenseHat.keyToDirection('ArrowDown')).to.equal('down');
    expect(SenseHat.keyToDirection('ArrowLeft')).to.equal('left');
    expect(SenseHat.keyToDirection('ArrowRight')).to.equal('right');
    expect(SenseHat.keyToDirection('Enter')).to.equal('middle');
  });
  it('returns null for unrelated keys', function() {
    expect(SenseHat.keyToDirection('a')).to.equal(null);
    expect(SenseHat.keyToDirection(' ')).to.equal(null);
  });
});
