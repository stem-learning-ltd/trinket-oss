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

  return {
    makeStick: makeStick,
    keyToDirection: keyToDirection,
    makeInputEvent: makeInputEvent,
    pushStickEvent: pushStickEvent,
    KEY_CODES: KEY_CODES,
    STATE: STATE
  };
});
