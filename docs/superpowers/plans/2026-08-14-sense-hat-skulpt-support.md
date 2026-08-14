# Sense HAT (Skulpt) Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make client-side `python` (Skulpt) Sense HAT trinkets run on our fork — render the 8×8 LED matrix and drive the joystick via keyboard + on-screen D-pad — by supplying the host-side JS the shipped Skulpt `sense_hat` module expects.

**Architecture:** One new lazy-loaded browser component (`public/js/embed/sense_hat.js`) exposing a `SenseHat` global, wired into Skulpt's existing graphics-library mechanism in `public/js/skulpt/wrapper.js` (the same lazy-load pattern as `processing`/`pygame`). The component creates `Sk.sense_hat` (+ a `sensestick` EventEmitter), installs `Sk.sense_hat_emit` to repaint a `<canvas>`, and feeds joystick `InputEvent`s from keyboard + D-pad. Pure logic is factored into small exported helpers, unit-tested with mocha; DOM/interaction is verified manually in a browser.

**Tech Stack:** Vanilla ES5 browser JS (no build step — served statically), Skulpt, jQuery (already global in the embed), mocha 3 + chai for unit tests.

---

## Contract reference (already verified — do not re-derive)

From the deployed `src/lib/_internal_sense_hat.js` and `sense_hat/stick.py`:

- Host must ensure `Sk.sense_hat` **exists** before the program runs, carrying a
  `sensestick` emitter. The module's `init()` self-fills `pixels`, `low_light`,
  `gamma`, `rtimu`.
- `Sk.sense_hat_emit(event, arg)` fires only: `init`, `setpixels`, `setpixel`,
  `changeLowlight`, `setGamma`. Each means "repaint from `Sk.sense_hat.pixels`
  (64 × `[r,g,b]`, raw 0–255) dimmed by `low_light`". `show_message`/`clear`/
  `set_rotation`/`flip_*` all arrive as `setpixels`.
- `Sk.sense_hat.sensestick` must expose `_eventQueue` (array), `_threadHandler`,
  and `on/once/off/emit` where handlers are called `fn(eventName, data)`.
- Joystick event object: `{ timestamp: seconds, key: <code>, state: <0|1|2>,
  type: 1 }`. Codes: up=103, down=108, left=105, right=106, middle(Enter)=28.
  States: release=0, press=1, hold=2. `data.type === 'keyboardinterrupt'`
  aborts a blocked read.

## File structure

- **Create `public/js/embed/sense_hat.js`** — the `SenseHat` component. UMD-style
  wrapper so it is a browser global *and* `require()`-able in Node for tests.
  Pure helpers (`makeStick`, `keyToDirection`, `makeInputEvent`, `pushStickEvent`,
  `pixelsToCells`, `KEY_CODES`, `STATE`) are exported for unit testing; `init`
  does the DOM/render/input wiring.
- **Create `test/lib/embed/sense_hat.js`** — mocha unit tests for the pure helpers
  (mirrors `test/lib/util/features.js`: requires `chai` + the module directly,
  no DB/app bootstrap).
- **Modify `public/js/skulpt/wrapper.js`** — add `sense_hat` to
  `GRAPHICS_LIBRARIES_REGEXP` (line 33) and add a `sense_hat` entry to
  `defaultGraphicsSetup` (before line 127).

Run a single test file during the TDD loop with:
`npx mocha test/lib/embed/sense_hat.js` (add `-g '<title>'` for one test).

---

### Task 1: Component scaffold + `makeStick` (sensestick EventEmitter)

**Files:**
- Create: `public/js/embed/sense_hat.js`
- Test: `test/lib/embed/sense_hat.js`

- [ ] **Step 1: Write the failing test**

Create `test/lib/embed/sense_hat.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/lib/embed/sense_hat.js`
Expected: FAIL — `Cannot find module '../../../public/js/embed/sense_hat.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `public/js/embed/sense_hat.js`:

```js
/**
 * Sense HAT host-side component for client-side (Skulpt) Python trinkets.
 * Supplies the JS half the shipped `sense_hat` Skulpt module expects:
 * creates Sk.sense_hat (+ sensestick), installs Sk.sense_hat_emit to render
 * the 8x8 LED matrix, and feeds joystick InputEvents from keyboard + D-pad.
 *
 * Lazy-loaded by public/js/skulpt/wrapper.js when a trinket imports sense_hat.
 * Pure helpers are exported for unit testing; init() does DOM/render/input.
 */
;(function(root, factory) {
  var SenseHat = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SenseHat;          // Node (tests)
  } else {
    root.SenseHat = SenseHat;           // browser global
  }
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // --- sensestick EventEmitter (matches _internal_sense_hat.js expectations) ---
  function makeStick() {
    var listeners = {};

    function on(evt, fn) {
      (listeners[evt] = listeners[evt] || []).push(fn);
    }
    function off(evt, fn) {
      if (!listeners[evt]) { return; }
      listeners[evt] = listeners[evt].filter(function(g) {
        return g !== fn && g.__orig !== fn;
      });
    }
    function once(evt, fn) {
      function wrapper() {
        off(evt, wrapper);
        return fn.apply(this, arguments);
      }
      wrapper.__orig = fn;
      on(evt, wrapper);
    }
    function emit(evt, data) {
      (listeners[evt] || []).slice().forEach(function(fn) {
        fn(evt, data);
      });
    }

    return {
      _eventQueue: [],
      _threadHandler: null,
      on: on,
      once: once,
      off: off,
      emit: emit
    };
  }

  return {
    makeStick: makeStick
  };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/lib/embed/sense_hat.js`
Expected: PASS — 5 passing.

- [ ] **Step 5: Commit**

```bash
git add public/js/embed/sense_hat.js test/lib/embed/sense_hat.js
git commit -m "feat(sense_hat): sensestick EventEmitter for Skulpt bridge (ENG-1887)"
```

---

### Task 2: `keyToDirection` (keyboard key → joystick direction)

**Files:**
- Modify: `public/js/embed/sense_hat.js`
- Test: `test/lib/embed/sense_hat.js`

- [ ] **Step 1: Write the failing test**

Append to `test/lib/embed/sense_hat.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/lib/embed/sense_hat.js -g keyToDirection`
Expected: FAIL — `TypeError: SenseHat.keyToDirection is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `public/js/embed/sense_hat.js`, add this function inside the factory, after `makeStick`:

```js
  // --- keyboard mapping ---
  function keyToDirection(key) {
    switch (key) {
      case 'ArrowUp':    return 'up';
      case 'ArrowDown':  return 'down';
      case 'ArrowLeft':  return 'left';
      case 'ArrowRight': return 'right';
      case 'Enter':      return 'middle';
      default:           return null;
    }
  }
```

And add it to the returned object:

```js
  return {
    makeStick: makeStick,
    keyToDirection: keyToDirection
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/lib/embed/sense_hat.js`
Expected: PASS — 7 passing.

- [ ] **Step 5: Commit**

```bash
git add public/js/embed/sense_hat.js test/lib/embed/sense_hat.js
git commit -m "feat(sense_hat): map arrow/Enter keys to joystick directions (ENG-1887)"
```

---

### Task 3: `KEY_CODES`, `STATE`, and `makeInputEvent`

**Files:**
- Modify: `public/js/embed/sense_hat.js`
- Test: `test/lib/embed/sense_hat.js`

- [ ] **Step 1: Write the failing test**

Append to `test/lib/embed/sense_hat.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/lib/embed/sense_hat.js -g makeInputEvent`
Expected: FAIL — reading `SenseHat.STATE.press` throws (`Cannot read property 'press' of undefined`).

- [ ] **Step 3: Write minimal implementation**

In `public/js/embed/sense_hat.js`, add near the top of the factory (before `makeStick`):

```js
  // --- constants (from sense_hat/stick.py) ---
  var KEY_CODES = { up: 103, down: 108, left: 105, right: 106, middle: 28 };
  var STATE = { release: 0, press: 1, hold: 2 };
  var EV_KEY = 1;
```

Add this function after `keyToDirection`:

```js
  function makeInputEvent(direction, state, nowMs) {
    return {
      timestamp: nowMs / 1000,
      key: KEY_CODES[direction],
      state: state,
      type: EV_KEY
    };
  }
```

Update the returned object:

```js
  return {
    makeStick: makeStick,
    keyToDirection: keyToDirection,
    makeInputEvent: makeInputEvent,
    KEY_CODES: KEY_CODES,
    STATE: STATE
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/lib/embed/sense_hat.js`
Expected: PASS — 10 passing.

- [ ] **Step 5: Commit**

```bash
git add public/js/embed/sense_hat.js test/lib/embed/sense_hat.js
git commit -m "feat(sense_hat): joystick key codes, states, and InputEvent builder (ENG-1887)"
```

---

### Task 4: `pushStickEvent` (enqueue + emit)

**Files:**
- Modify: `public/js/embed/sense_hat.js`
- Test: `test/lib/embed/sense_hat.js`

- [ ] **Step 1: Write the failing test**

Append to `test/lib/embed/sense_hat.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/lib/embed/sense_hat.js -g pushStickEvent`
Expected: FAIL — `TypeError: SenseHat.pushStickEvent is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `public/js/embed/sense_hat.js`, add after `makeInputEvent`:

```js
  function pushStickEvent(stick, direction, state, nowMs) {
    if (!KEY_CODES.hasOwnProperty(direction)) { return false; }
    stick._eventQueue.push(makeInputEvent(direction, state, nowMs));
    stick.emit('sensestick.input', { type: 'keydown' });
    return true;
  }
```

Update the returned object to include `pushStickEvent: pushStickEvent,` (after `makeInputEvent`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/lib/embed/sense_hat.js`
Expected: PASS — 12 passing.

- [ ] **Step 5: Commit**

```bash
git add public/js/embed/sense_hat.js test/lib/embed/sense_hat.js
git commit -m "feat(sense_hat): push joystick events onto the sensestick queue (ENG-1887)"
```

---

### Task 5: `pixelsToCells` (pixel buffer → CSS colours, with low_light dim)

**Files:**
- Modify: `public/js/embed/sense_hat.js`
- Test: `test/lib/embed/sense_hat.js`

- [ ] **Step 1: Write the failing test**

Append to `test/lib/embed/sense_hat.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/lib/embed/sense_hat.js -g pixelsToCells`
Expected: FAIL — `TypeError: SenseHat.pixelsToCells is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `public/js/embed/sense_hat.js`, add after `pushStickEvent`:

```js
  // --- rendering (pure part) ---
  var LOW_LIGHT_FACTOR = 0.4;

  function clampByte(n) {
    n = Math.round(n);
    if (n < 0) { return 0; }
    if (n > 255) { return 255; }
    return n;
  }

  function pixelsToCells(pixels, lowLight) {
    var factor = lowLight ? LOW_LIGHT_FACTOR : 1;
    return pixels.map(function(px) {
      px = px || [];
      var r = clampByte((px[0] || 0) * factor);
      var g = clampByte((px[1] || 0) * factor);
      var b = clampByte((px[2] || 0) * factor);
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    });
  }
```

Update the returned object to include `pixelsToCells: pixelsToCells,` (after `pushStickEvent`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/lib/embed/sense_hat.js`
Expected: PASS — 15 passing.

- [ ] **Step 5: Commit**

```bash
git add public/js/embed/sense_hat.js test/lib/embed/sense_hat.js
git commit -m "feat(sense_hat): pixel buffer to cell colours with low_light dim (ENG-1887)"
```

---

### Task 6: `init` — DOM, canvas render, input wiring, emit, teardown

DOM/canvas/timer code is browser-only; it is verified manually in Task 8. Here we
add the full `init` implementation plus a smoke test that it is exported.

**Files:**
- Modify: `public/js/embed/sense_hat.js`
- Test: `test/lib/embed/sense_hat.js`

- [ ] **Step 1: Write the failing smoke test**

Append to `test/lib/embed/sense_hat.js`:

```js
describe('SenseHat.init', function() {
  it('is exposed as a function', function() {
    expect(SenseHat.init).to.be.a('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/lib/embed/sense_hat.js -g 'SenseHat.init'`
Expected: FAIL — `expected undefined to be a function`.

- [ ] **Step 3: Add the CSS string and DOM/render helpers**

In `public/js/embed/sense_hat.js`, add after the `pixelsToCells` block:

```js
  var SENSE_HAT_CSS =
    '.sense-hat{display:flex;flex-direction:column;align-items:center;' +
    'gap:12px;padding:12px;outline:none;}' +
    '.sense-hat-matrix{width:16rem;height:16rem;max-width:92%;' +
    'aspect-ratio:1/1;background:#111;border-radius:8px;touch-action:none;}' +
    '.sense-hat-dpad{display:grid;grid-template-columns:repeat(3,40px);' +
    'grid-template-rows:repeat(3,40px);gap:4px;}' +
    '.sense-hat-dpad-btn{border:1px solid #888;background:#f4f4f4;' +
    'border-radius:6px;cursor:pointer;font-size:14px;line-height:1;' +
    'touch-action:none;}' +
    '.sense-hat-dpad-btn.up{grid-area:1/2;}' +
    '.sense-hat-dpad-btn.left{grid-area:2/1;}' +
    '.sense-hat-dpad-btn.middle{grid-area:2/2;}' +
    '.sense-hat-dpad-btn.right{grid-area:2/3;}' +
    '.sense-hat-dpad-btn.down{grid-area:3/2;}';

  function injectStyles() {
    if (typeof document === 'undefined') { return; }
    if (document.getElementById('sense-hat-styles')) { return; }
    var style = document.createElement('style');
    style.id = 'sense-hat-styles';
    style.textContent = SENSE_HAT_CSS;
    document.head.appendChild(style);
  }

  function blankPixels() {
    var a = [];
    for (var i = 0; i < 64; i++) { a.push([0, 0, 0]); }
    return a;
  }
  function makeZeroGamma() {
    var a = [];
    for (var i = 0; i < 32; i++) { a.push(0); }
    return a;
  }
  function defaultRtimu() {
    return {
      pressure: [1, 0], temperature: [1, 0], humidity: [1, 0],
      gyro: [0, 0, 0], accel: [0, 0, 0], compass: [0, 0, 0], fusionPose: [0, 0, 0]
    };
  }
  function now() { return Date.now(); }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function buildDpad() {
    var el = document.createElement('div');
    el.className = 'sense-hat-dpad';
    var defs = [
      { direction: 'up',     label: '▲', cls: 'up' },
      { direction: 'left',   label: '◀', cls: 'left' },
      { direction: 'middle', label: '●', cls: 'middle' },
      { direction: 'right',  label: '▶', cls: 'right' },
      { direction: 'down',   label: '▼', cls: 'down' }
    ];
    var buttons = defs.map(function(d) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sense-hat-dpad-btn ' + d.cls;
      b.setAttribute('aria-label', 'joystick ' + d.direction);
      b.textContent = d.label;
      el.appendChild(b);
      return { el: b, direction: d.direction };
    });
    return { el: el, buttons: buttons };
  }

  function buildUI($target) {
    var wrap = document.createElement('div');
    wrap.className = 'sense-hat';
    var canvas = document.createElement('canvas');
    canvas.className = 'sense-hat-matrix';
    canvas.width = 256;
    canvas.height = 256;
    wrap.appendChild(canvas);
    var dpad = buildDpad();
    wrap.appendChild(dpad.el);
    $target.empty().append(wrap);
    return {
      root: wrap,
      canvas: canvas,
      ctx: canvas.getContext('2d'),
      dpad: dpad,
      teardownDom: function() {
        if (wrap.parentNode) { wrap.parentNode.removeChild(wrap); }
      }
    };
  }

  function paint(ui, cells) {
    var ctx = ui.ctx, size = ui.canvas.width, n = 8, cs = size / n, pad = cs * 0.12;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, size, size);
    for (var i = 0; i < 64; i++) {
      var x = (i % n) * cs, y = Math.floor(i / n) * cs;
      ctx.fillStyle = cells[i];
      roundRect(ctx, x + pad, y + pad, cs - 2 * pad, cs - 2 * pad, (cs - 2 * pad) * 0.25);
      ctx.fill();
    }
  }

  function ensureFocusable(el) {
    if (!el.getAttribute('tabindex')) { el.setAttribute('tabindex', '0'); }
    if (!el.getAttribute('role')) { el.setAttribute('role', 'application'); }
    try { el.focus(); } catch (e) { /* ignore */ }
  }
```

- [ ] **Step 4: Add input + abort wiring**

In `public/js/embed/sense_hat.js`, add after `ensureFocusable`:

```js
  function wireInput(ui, stick) {
    function down(direction, isRepeat) {
      if (!direction) { return; }
      pushStickEvent(stick, direction, isRepeat ? STATE.hold : STATE.press, now());
    }
    function up(direction) {
      if (!direction) { return; }
      pushStickEvent(stick, direction, STATE.release, now());
    }
    function onKeyDown(e) {
      var d = keyToDirection(e.key);
      if (!d) { return; }
      e.preventDefault();
      down(d, e.repeat);
    }
    function onKeyUp(e) {
      var d = keyToDirection(e.key);
      if (!d) { return; }
      e.preventDefault();
      up(d);
    }
    ui.root.addEventListener('keydown', onKeyDown);
    ui.root.addEventListener('keyup', onKeyUp);

    var dpadHandlers = [];
    ui.dpad.buttons.forEach(function(btn) {
      function pd(e) { e.preventDefault(); ui.root.focus(); down(btn.direction, false); }
      function pu(e) { e.preventDefault(); up(btn.direction); }
      btn.el.addEventListener('pointerdown', pd);
      btn.el.addEventListener('pointerup', pu);
      btn.el.addEventListener('pointerleave', pu);
      dpadHandlers.push([btn.el, pd, pu]);
    });

    return function detach() {
      ui.root.removeEventListener('keydown', onKeyDown);
      ui.root.removeEventListener('keyup', onKeyUp);
      dpadHandlers.forEach(function(h) {
        h[0].removeEventListener('pointerdown', h[1]);
        h[0].removeEventListener('pointerup', h[2]);
        h[0].removeEventListener('pointerleave', h[2]);
      });
    };
  }

  // On Stop, the embed sets window.Sk_interrupt = true. A program blocked in
  // stick.wait_for_event()/_read is a Promise-suspension that our normal poll
  // can't break, so emit a keyboardinterrupt into the stick to abort it.
  function wireAbort(stick) {
    var fired = false;
    var handle = setInterval(function() {
      if (typeof window !== 'undefined' && window.Sk_interrupt === true) {
        if (!fired) {
          fired = true;
          stick.emit('sensestick.input', { type: 'keyboardinterrupt' });
        }
      } else {
        fired = false;
      }
    }, 100);
    return function detach() { clearInterval(handle); };
  }
```

- [ ] **Step 5: Add `init` and export it**

In `public/js/embed/sense_hat.js`, add after `wireAbort`:

```js
  function init(config, $target) {
    // idempotent re-runs: tear down any prior instance
    if (typeof Sk !== 'undefined' && Sk.sense_hat &&
        typeof Sk.sense_hat._destroy === 'function') {
      Sk.sense_hat._destroy();
    }
    injectStyles();

    var stick = makeStick();
    Sk.sense_hat = {
      pixels: blankPixels(),
      low_light: false,
      gamma: makeZeroGamma(),
      rtimu: defaultRtimu(),
      sensestick: stick
    };

    var ui = buildUI($target);
    ensureFocusable(ui.root);

    function render() {
      paint(ui, pixelsToCells(Sk.sense_hat.pixels, Sk.sense_hat.low_light));
    }

    // init, setpixels, setpixel, changeLowlight, setGamma -> repaint from state
    Sk.sense_hat_emit = function(/* event, arg */) {
      render();
    };

    var detachInput = wireInput(ui, stick);
    var detachAbort = wireAbort(stick);

    Sk.sense_hat._destroy = function() {
      detachInput();
      detachAbort();
      ui.teardownDom();
    };

    render(); // paint the blank grid immediately
    return Sk.sense_hat._destroy;
  }
```

Update the returned object to add `init: init,` as its first property:

```js
  return {
    init: init,
    makeStick: makeStick,
    keyToDirection: keyToDirection,
    makeInputEvent: makeInputEvent,
    pushStickEvent: pushStickEvent,
    pixelsToCells: pixelsToCells,
    KEY_CODES: KEY_CODES,
    STATE: STATE
  };
```

- [ ] **Step 6: Run the full test file to verify it passes**

Run: `npx mocha test/lib/embed/sense_hat.js`
Expected: PASS — 16 passing.

- [ ] **Step 7: Commit**

```bash
git add public/js/embed/sense_hat.js test/lib/embed/sense_hat.js
git commit -m "feat(sense_hat): init — render 8x8 matrix, wire joystick, teardown (ENG-1887)"
```

---

### Task 7: Wire `sense_hat` into the Skulpt graphics mechanism

No unit test (browser IIFE with `TrinketIO`/`$`/`Detectizr` deps); correctness is
confirmed by the regexp check below and by Task 8's manual run.

**Files:**
- Modify: `public/js/skulpt/wrapper.js:33` (regexp)
- Modify: `public/js/skulpt/wrapper.js` (add `defaultGraphicsSetup.sense_hat`, before line 127)

- [ ] **Step 1: Add `sense_hat` to the graphics-library regexp**

In `public/js/skulpt/wrapper.js`, change line 33 from:

```js
var GRAPHICS_LIBRARIES_REGEXP = /^(turtle|processing|matplotlib\.pyplot|image)$/i;
```

to:

```js
var GRAPHICS_LIBRARIES_REGEXP = /^(turtle|processing|matplotlib\.pyplot|image|sense_hat)$/i;
```

- [ ] **Step 2: Add the `sense_hat` graphics-setup entry**

In `public/js/skulpt/wrapper.js`, inside `defaultGraphicsSetup`, add a new entry
after the `'matplotlib.pyplot'` function (which ends `}` just before the closing
`};` of `defaultGraphicsSetup` around line 127). Add a comma after the
`matplotlib.pyplot` entry's closing brace, then:

```js
  'sense_hat' : function(config, $target) {
    var senseHatUrl = trinketConfig.prefix('/js/embed/sense_hat.js');
    $target.data("graphicMode", "sense_hat");
    return loadExternalLibraryInternal_(senseHatUrl, true).then(function() {
      return SenseHat.init(config, $target);
    });
  }
```

The resulting tail of `defaultGraphicsSetup` should read:

```js
  'matplotlib.pyplot' : function(config, $target) {
    if (typeof destroyGraphicsFn === 'function') {
      destroyGraphicsFn();
    }

    var matplotlibCanvasId = Sk.canvas = 'matplotlibCanvas';
    $target.data("graphicMode", "matplot");
    return $target.html(
      '<div id="' + matplotlibCanvasId + '"></div>'
    );
  },
  'sense_hat' : function(config, $target) {
    var senseHatUrl = trinketConfig.prefix('/js/embed/sense_hat.js');
    $target.data("graphicMode", "sense_hat");
    return loadExternalLibraryInternal_(senseHatUrl, true).then(function() {
      return SenseHat.init(config, $target);
    });
  }
};
```

- [ ] **Step 3: Verify the regexp change is correct**

Run:
```bash
node -e "var re=/^(turtle|processing|matplotlib\.pyplot|image|sense_hat)\$/i; console.log(re.test('sense_hat'), re.test('sense_hat.stick'), re.test('turtle'))"
```
Expected: `true false true` (matches `sense_hat`, not its submodules, still matches `turtle`).

- [ ] **Step 4: Verify both edits are present in the file**

Run:
```bash
grep -n "sense_hat" public/js/skulpt/wrapper.js
```
Expected: two hits — the regexp on line 33 and the `'sense_hat' :` graphics-setup entry.

- [ ] **Step 5: Confirm existing unit tests still pass**

Run: `npx mocha test/lib/embed/sense_hat.js`
Expected: PASS — 16 passing (wrapper edit does not affect these; this confirms no
accidental damage to the component module).

- [ ] **Step 6: Commit**

```bash
git add public/js/skulpt/wrapper.js
git commit -m "feat(sense_hat): lazy-load + wire sense_hat into Skulpt graphics setup (ENG-1887)"
```

---

### Task 8: Manual browser verification

No code changes — validate real behaviour in a running instance using the
`superpowers:verification-before-completion` / `verify` / `run` skills. Record the
outcome of each check before claiming completion.

**Setup:**

- [ ] **Step 1: Run the app locally and open a client-side Python trinket editor**

Use the `run` skill (or `docker-compose up`) to start the instance, sign in with a
local/staff account, and create a **new `python` (not python3) trinket**. `python`
is the Skulpt runtime that ships the `sense_hat` module.

**LED matrix (covers 8/10 trinkets):**

- [ ] **Step 2: Paste the reported trinket code and Run**

Paste the exact code from ENG-1887 (the `trinket_logo`/`raspi_logo`/`heart`
animation loop, `from sense_hat import SenseHat` … `while True: s.set_pixels(...)`).

Expected: **no** `SenseHat Browser storage must be set` error; an 8×8 LED grid
renders in the output area and cycles through the logo/plus/raspi/equals/heart
frames roughly every 0.75s.

- [ ] **Step 3: Verify low_light dims the display**

The reported code sets `s.low_light = True`. Compare brightness with the same code
edited to `s.low_light = False`.

Expected: `low_light = True` renders visibly dimmer.

**Joystick (covers the 2 interactive trinkets):**

- [ ] **Step 4: Run a joystick trinket and drive it with the keyboard**

Replace the code with:

```python
from sense_hat import SenseHat
sense = SenseHat()
sense.clear()
while True:
    event = sense.stick.wait_for_event()
    if event.action == 'pressed':
        if event.direction == 'up':
            sense.clear(0, 255, 0)
        elif event.direction == 'down':
            sense.clear(0, 0, 255)
        elif event.direction == 'middle':
            sense.clear(255, 255, 255)
        else:
            sense.clear(255, 0, 0)
```

Click the output area to focus it, then press arrow keys and Enter.

Expected: ↑ turns the grid green, ↓ blue, Enter white, ←/→ red.

- [ ] **Step 5: Drive the same trinket with the on-screen D-pad**

Click the D-pad's up/down/middle/left/right buttons.

Expected: same colour responses as Step 4 (D-pad works without keyboard focus).

- [ ] **Step 6: Verify Stop aborts a blocked wait_for_event**

While the Step 4 program is parked in `wait_for_event()` (no input yet), click
Stop.

Expected: the program stops promptly (the `keyboardinterrupt` path breaks the
blocked read) rather than hanging.

- [ ] **Step 7: Verify idempotent re-run**

Run the trinket, then Run again several times.

Expected: exactly one LED grid + one D-pad each time (no stacked/duplicated
canvases), and joystick input still works after re-running.

- [ ] **Step 8: Record results and finish the branch**

Note pass/fail for Steps 2–7. If all pass, use
`superpowers:finishing-a-development-branch` to open the PR against
`fly-production` for ENG-1887. If anything fails, use `superpowers:systematic-debugging`
before claiming completion.

---

## Self-review notes

- **Spec coverage:** LED render + pixel storage → Tasks 5–6 + emit wiring;
  joystick queue → Tasks 1,3,4,6; keyboard + D-pad → Task 6 (`wireInput`) + Task 8
  Steps 4–5; low_light dim → Task 5 + Task 8 Step 3; lazy-load on import → Task 7;
  blocked-read Stop → Task 6 (`wireAbort`) + Task 8 Step 6; idempotent re-run →
  Task 6 (`_destroy`) + Task 8 Step 7; sensors out of scope → not implemented (per
  spec). All spec sections map to a task.
- **Types/names consistent across tasks:** `makeStick`, `keyToDirection`,
  `makeInputEvent`, `pushStickEvent`, `pixelsToCells`, `KEY_CODES`, `STATE`,
  `init` are defined once and referenced with the same signatures throughout;
  the returned object grows monotonically and lists only defined helpers at each
  step (module stays `require`-able after every task).
- **No placeholders:** every code/test/command step contains complete, runnable
  content.
