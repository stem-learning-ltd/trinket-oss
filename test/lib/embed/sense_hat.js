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

describe('SenseHat.makeInputEvent', function() {
  it('builds the (timestamp, key, state, type) event shape', function() {
    var e = SenseHat.makeInputEvent('up', SenseHat.STATE.press, 1500);
    expect(e).to.deep.equal({ timestamp: 1.5, key: 103, state: 1, type: 1 });
  });
  it('maps every direction to its Linux key code', function() {
    expect(SenseHat.KEY_CODES).to.deep.equal(
      { up: 103, down: 108, left: 105, right: 106, middle: 28 });
  });
  it('exposes press/release/hold states', function() {
    expect(SenseHat.STATE).to.deep.equal({ release: 0, press: 1, hold: 2 });
  });
});

describe('SenseHat.pushStickEvent', function() {
  it('enqueues an event and emits sensestick.input', function() {
    var s = SenseHat.makeStick();
    var received = [];
    s.once('sensestick.input', function(evt, data) { received.push(data); });
    var ok = SenseHat.pushStickEvent(s, 'left', SenseHat.STATE.press, 2000);
    expect(ok).to.equal(true);
    expect(s._eventQueue).to.have.length(1);
    expect(s._eventQueue[0]).to.deep.equal(
      { timestamp: 2, key: 105, state: 1, type: 1 });
    expect(received).to.deep.equal([{ type: 'keydown' }]);
  });
  it('ignores unknown directions without touching the queue', function() {
    var s = SenseHat.makeStick();
    var ok = SenseHat.pushStickEvent(s, 'nowhere', SenseHat.STATE.press, 2000);
    expect(ok).to.equal(false);
    expect(s._eventQueue).to.have.length(0);
  });
});

describe('SenseHat.pixelsToCells', function() {
  function fill(color) {
    var a = [];
    for (var i = 0; i < 64; i++) { a.push(color.slice()); }
    return a;
  }
  it('maps raw pixels to rgb() strings at full brightness', function() {
    var cells = SenseHat.pixelsToCells(fill([255, 0, 0]), false);
    expect(cells).to.have.length(64);
    expect(cells[0]).to.equal('rgb(255,0,0)');
  });
  it('dims every channel when low_light is on', function() {
    var cells = SenseHat.pixelsToCells(fill([255, 255, 255]), true);
    expect(cells[0]).to.equal('rgb(102,102,102)'); // round(255 * 0.4)
  });
  it('treats missing channels as zero', function() {
    var cells = SenseHat.pixelsToCells([[10]], false);
    expect(cells[0]).to.equal('rgb(10,0,0)');
  });
});

describe('SenseHat.init', function() {
  it('is exposed as a function', function() {
    expect(SenseHat.init).to.be.a('function');
  });
});
