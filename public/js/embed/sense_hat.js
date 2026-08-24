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

  // --- constants (from sense_hat/stick.py) ---
  var KEY_CODES = { up: 103, down: 108, left: 105, right: 106, middle: 28 };
  var STATE = { release: 0, press: 1, hold: 2 };
  var EV_KEY = 1;

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

  function makeInputEvent(direction, state, nowMs) {
    return {
      timestamp: nowMs / 1000,
      key: KEY_CODES[direction],
      state: state,
      type: EV_KEY
    };
  }

  function pushStickEvent(stick, direction, state, nowMs) {
    if (!KEY_CODES.hasOwnProperty(direction)) { return false; }
    stick._eventQueue.push(makeInputEvent(direction, state, nowMs));
    stick.emit('sensestick.input', { type: 'keydown' });
    return true;
  }

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

  // --- environmental sensors (ENG-2289) ---
  // The bridge (_internal_sense_hat.js) reads Sk.sense_hat.rtimu.<name> as a
  // [valid, value] pair on every Python call and re-checks the range each
  // time, so a slider only has to keep that pair updated. Ranges below are
  // the bridge's own valid ranges — anything the slider can produce is a
  // reading get_temperature() will accept.
  var SENSOR_SPECS = {
    temperature: { min: -40, max: 120, step: 1, initial: 25, unit: '° C', icon: '🌡️' }
  };

  // Last slider positions, kept across re-runs within the page so Run doesn't
  // reset a learner's chosen value.
  var sensorValues = {};

  function clampSensorValue(name, raw) {
    var spec = SENSOR_SPECS[name];
    if (!spec) { return null; }
    var n = parseFloat(raw);
    if (isNaN(n) || !isFinite(n)) { return null; }
    if (n < spec.min) { return spec.min; }
    if (n > spec.max) { return spec.max; }
    return n;
  }

  function applySensorValue(state, name, raw) {
    var value = clampSensorValue(name, raw);
    if (value === null) { return null; }
    state.rtimu[name] = [1, value];
    return value;
  }

  function formatSensorReadout(name, value) {
    return value + SENSOR_SPECS[name].unit;
  }

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

  // The embed page ships Foundation, whose bare `button` rule adds 2rem side
  // padding (overflowing the 40px grid tracks so buttons overlap), a bottom
  // margin, white text and a blue :hover/:focus at specificity 0-1-1 — so the
  // D-pad buttons must own every one of those properties, and the state rules
  // need 0-2-1 selectors to win regardless of stylesheet order.
  var SENSE_HAT_CSS =
    '.sense-hat{display:flex;flex-direction:column;align-items:center;' +
    'gap:12px;padding:12px;outline:none;}' +
    '.sense-hat-matrix{width:16rem;height:16rem;max-width:92%;' +
    'aspect-ratio:1/1;background:#111;border-radius:8px;touch-action:none;}' +
    // Sensor rows: Foundation's bare `label` rule sets display:block, 0.875rem
    // and #4d4d4d at 0-0-1, so the row class owns those; range inputs are
    // untouched by Foundation but margin/width are set anyway for safety.
    '.sense-hat-sensors{display:flex;flex-direction:column;gap:8px;' +
    'width:16rem;max-width:92%;}' +
    '.sense-hat-sensor{display:flex;align-items:center;gap:8px;margin:0;' +
    'padding:0;color:#333;font-size:14px;line-height:1;cursor:pointer;}' +
    '.sense-hat-sensor-icon{font-size:16px;}' +
    '.sense-hat-sensor-slider{flex:1;min-width:0;width:auto;margin:0;' +
    'padding:0;accent-color:#2879d0;}' +
    '.sense-hat-sensor-readout{min-width:3.5em;text-align:right;' +
    'font-variant-numeric:tabular-nums;}' +
    '.sense-hat-dpad{display:grid;grid-template-columns:repeat(3,40px);' +
    'grid-template-rows:repeat(3,40px);gap:6px;}' +
    '.sense-hat-dpad-btn{margin:0;padding:0;border:1px solid #1a1a1a;' +
    'background:#333;color:#fff;border-radius:6px;cursor:pointer;' +
    'font-size:16px;line-height:1;touch-action:none;' +
    'transition:background-color 60ms ease-out;}' +
    '.sense-hat-dpad .sense-hat-dpad-btn:hover,' +
    '.sense-hat-dpad .sense-hat-dpad-btn:focus{background:#4d4d4d;color:#fff;}' +
    '.sense-hat-dpad .sense-hat-dpad-btn:active{background:#606060;}' +
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

  // One row per SENSOR_SPECS entry: icon | slider | readout. Applies the
  // persisted (or initial) value into state.rtimu immediately so the sensor
  // reads correctly before the slider is ever touched.
  function buildSensors(state) {
    var el = document.createElement('div');
    el.className = 'sense-hat-sensors';
    Object.keys(SENSOR_SPECS).forEach(function(name) {
      var spec = SENSOR_SPECS[name];
      var row = document.createElement('label');
      row.className = 'sense-hat-sensor';
      var icon = document.createElement('span');
      icon.className = 'sense-hat-sensor-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = spec.icon;
      var input = document.createElement('input');
      input.type = 'range';
      input.className = 'sense-hat-sensor-slider';
      input.min = spec.min;
      input.max = spec.max;
      input.step = spec.step;
      input.setAttribute('aria-label', name);
      var readout = document.createElement('span');
      readout.className = 'sense-hat-sensor-readout';
      function apply(raw) {
        var value = applySensorValue(state, name, raw);
        if (value === null) { return; }
        sensorValues[name] = value;
        readout.textContent = formatSensorReadout(name, value);
      }
      input.value = sensorValues.hasOwnProperty(name) ? sensorValues[name] : spec.initial;
      apply(input.value);
      input.addEventListener('input', function() { apply(input.value); });
      row.appendChild(icon);
      row.appendChild(input);
      row.appendChild(readout);
      el.appendChild(row);
    });
    return el;
  }

  function buildUI($target, state) {
    var wrap = document.createElement('div');
    wrap.className = 'sense-hat';
    wrap.appendChild(buildSensors(state));
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
    // fillStyle must be set before roundRect() (which calls beginPath), then fill().
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

  function wireInput(ui, stick) {
    function down(direction, isRepeat) {
      if (!direction) { return; }
      pushStickEvent(stick, direction, isRepeat ? STATE.hold : STATE.press, now());
    }
    function up(direction) {
      if (!direction) { return; }
      pushStickEvent(stick, direction, STATE.release, now());
    }
    // Keys from a focused sensor slider stay with the slider — otherwise
    // arrows would fire joystick events and preventDefault would stop the
    // slider moving.
    function onKeyDown(e) {
      if (e.target && e.target.tagName === 'INPUT') { return; }
      var d = keyToDirection(e.key);
      if (!d) { return; }
      e.preventDefault();
      down(d, e.repeat);
    }
    function onKeyUp(e) {
      if (e.target && e.target.tagName === 'INPUT') { return; }
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
      dpadHandlers.push({ el: btn.el, pd: pd, pu: pu });
    });

    return function detach() {
      ui.root.removeEventListener('keydown', onKeyDown);
      ui.root.removeEventListener('keyup', onKeyUp);
      dpadHandlers.forEach(function(h) {
        h.el.removeEventListener('pointerdown', h.pd);
        h.el.removeEventListener('pointerup', h.pu);
        h.el.removeEventListener('pointerleave', h.pu);
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

  // config is supplied by the Skulpt graphics-setup mechanism and currently reserved for future use.
  function init(config, $target) {
    // idempotent re-runs: tear down any prior instance
    if (typeof Sk !== 'undefined' && Sk.sense_hat &&
        typeof Sk.sense_hat._destroy === 'function') {
      Sk.sense_hat._destroy();
    }
    injectStyles();

    var stick = makeStick();
    var state = {
      pixels: blankPixels(),
      low_light: false,
      gamma: makeZeroGamma(),
      rtimu: defaultRtimu(),
      sensestick: stick
    };
    Sk.sense_hat = state;

    var destroyed = false;
    var ui = buildUI($target, state);
    ensureFocusable(ui.root);

    function render() {
      if (destroyed) { return; }
      paint(ui, pixelsToCells(state.pixels, state.low_light));
    }

    // init, setpixels, setpixel, changeLowlight, setGamma -> repaint from state
    Sk.sense_hat_emit = function(/* event, arg */) {
      render();
    };

    var detachInput = wireInput(ui, stick);
    var detachAbort = wireAbort(stick);

    state._destroy = function() {
      destroyed = true;
      detachInput();
      detachAbort();
      ui.teardownDom();
      if (Sk.sense_hat === state) {
        Sk.sense_hat_emit = null;
        Sk.sense_hat = null;
      }
    };

    render(); // paint the blank grid immediately
    return state._destroy;
  }

  return {
    init: init,
    makeStick: makeStick,
    keyToDirection: keyToDirection,
    makeInputEvent: makeInputEvent,
    pushStickEvent: pushStickEvent,
    pixelsToCells: pixelsToCells,
    SENSOR_SPECS: SENSOR_SPECS,
    clampSensorValue: clampSensorValue,
    applySensorValue: applySensorValue,
    formatSensorReadout: formatSensorReadout,
    KEY_CODES: KEY_CODES,
    STATE: STATE
  };
});
