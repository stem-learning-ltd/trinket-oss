# Sense HAT support for client-side (Skulpt) Python trinkets

**Date:** 2026-08-14
**Linear:** [ENG-1887](https://linear.app/stem-learning/issue/ENG-1887/sense-hat-issue-externalerror-error-sensehat-browser-storage-must-be)
**Status:** Approved design — pending implementation plan

## Problem

Client-side `python` (Skulpt) trinkets that use the Sense HAT fail on
`ide.stem.org.uk`. The first call — `SenseHat()` on line 4 of the reported
trinket — throws:

```
ExternalError: Error: SenseHat Browser storage must be set: Sk.sense_hat must exist
```

Our Skulpt fork already ships the **Python-facing** half of the Sense HAT
support: the `sense_hat` package (`__init__.py`, `hat.py`, `stick.py`,
`_sense_hat_text_dict.py`) and the internal bridge `_internal_sense_hat.js`.
That bridge reads/writes a host-provided JS object `Sk.sense_hat` and fires
`Sk.sense_hat_emit(...)` to drive a display. **trinket-oss's frontend never
creates `Sk.sense_hat`, never handles the emits, and ships no Sense HAT UI** —
so the very first constructor call throws.

This is a **frontend feature**, not a config flip. The fix is the host-side JS
that trinket.io ("Strive") added on their own deployment.

Confirmed against the deployed Skulpt bundle
(`trinket-cdn.trinket.io/…-skulpt-stdlib.js`): `src/lib/sense_hat/*` and
`src/lib/_internal_sense_hat.js` are present; `grep` finds **no** reference to
`sense`/`Sk.sense_hat` anywhere in trinket-oss.

## Scope

Driven by the usage breakdown on the ticket (10 in-use trinkets):

| Capability | Trinkets | In scope |
|---|---|---|
| LED matrix render + pixel storage (`set_pixels`, `clear`, `show_message`, …) | 10 / 10 | **Yes** |
| Joystick event queue (`sensestick`) | 2 / 10 | **Yes** |
| `low_light` | 1 / 10 (not a blocker) | **Yes** (display dim) |
| Environmental / IMU sensors (`rtimu`: temp, humidity, pressure, compass, gyro, accel, orientation) | 0 / 10 | **No (YAGNI)** |

### Goals

- Sense HAT `python` (Skulpt) trinkets run without error and display the 8×8
  LED matrix, covering `set_pixels`, `clear`, `show_message`, `show_letter`,
  `set_rotation`, `flip_h/v`, per-pixel `set_pixel`.
- The joystick works via keyboard (arrows + Enter) **and** an on-screen D-pad,
  feeding the `sensestick` event queue so `wait_for_event()`, `get_events()`,
  and `direction_*` callbacks behave.
- `low_light` visibly dims the display (nice-to-have; never a blocker).
- Loaded only when a trinket imports `sense_hat` — zero cost otherwise.
- Vanilla open-source behaviour is preserved for every other library.

### Non-goals

- Environmental/IMU **sensor input widgets** — 0 current trinkets use them. The
  module's own reads return "invalid" defaults rather than throwing, so
  unwired sensors degrade gracefully.
- The colour sensor (`Sk.sense_hat.colour`) and motion (`#sense_hat_motion`)
  paths — also unused by current trinkets.
- Server-side **python3** Sense HAT support — python3 runs on our servers, not
  Skulpt; unaffected and out of scope.

## Contract (verified against the shipped `_internal_sense_hat.js`)

The host must provide, **before the program runs**, a global `Sk.sense_hat`
object. The bridge's `init()` self-fills defaults for `pixels`, `low_light`,
`gamma`, and `rtimu` if absent — so the host strictly must guarantee only that
`Sk.sense_hat` **exists** and carries a working `sensestick` emitter (the bridge
never creates `sensestick` itself).

### Emits the host must handle (`Sk.sense_hat_emit(event, arg)`)

Only five are ever fired:

| Event | Fired when | Host action |
|---|---|---|
| `init` | `SenseHat()` constructed | Paint current (blank) buffer |
| `setpixels`, `_indexes` | `set_pixels` (and everything built on it) | Full repaint of `Sk.sense_hat.pixels` |
| `setpixel`, `_index` | `set_pixel` | Repaint one cell |
| `changeLowlight`, `_value` | `low_light` setter | Re-render with dim factor |
| `setGamma` | `set_gamma` | Re-render (brightness) |

`show_message`, `show_letter`, `clear`, `set_rotation`, `flip_h`, `flip_v` all
funnel through `set_pixels` in Python, so they arrive as ordinary `setpixels`
frames. **No text/scroll/rotation logic is needed host-side.**

`Sk.sense_hat.pixels` is 64 × `[r, g, b]` (row-major, 0–255), stored raw
(un-gamma'd). `low_light`/`gamma` affect brightness only.

### Joystick contract

`Sk.sense_hat.sensestick` must be an EventEmitter exposing:

- `_eventQueue` — array; the bridge `.shift()`s events off it
- `_threadHandler` — slot the bridge sets/clears
- `on(evt, fn)`, `once(evt, fn)`, `off(evt, fn)`, `emit(evt, data)` — handlers
  are invoked as `fn(eventName, data)` and may read `data.type`

On an input, the host pushes an event object and emits `'sensestick.input'`:

```js
{ timestamp: Date.now() / 1000, key: <code>, state: <0|1|2>, type: 1 /* EV_KEY */ }
```

Key codes (Linux input codes, from `stick.py`): `UP=103`, `DOWN=108`,
`LEFT=105`, `RIGHT=106`, `ENTER=28` (middle press). States:
`RELEASE=0`, `PRESS=1`, `HOLD=2`. The bridge's `_read` returns the
`(timestamp, key, state, type)` tuple; `stick.py` maps it to an `InputEvent`
with `direction` ∈ {up,down,left,right,middle} and `action` ∈
{pressed,released,held}. A `data.type === 'keyboardinterrupt'` breaks blocked
reads.

## Design

### Integration — reuse the existing graphics-library mechanism

`Sk.onBeforeImport(library)` (in `public/js/skulpt/wrapper.js`) already routes
imports: any library matching `GRAPHICS_LIBRARIES_REGEXP` is dispatched to
`config.graphicsSetup[library](config, $target)`; everything else falls through
to `config.onBeforeImport`. `processing` is the exact model to copy — its setup
**lazy-loads a component script, then prepares the `#graphic` target**.

Two small edits to `wrapper.js`:

1. Add `sense_hat` to `GRAPHICS_LIBRARIES_REGEXP`.
2. Add a `defaultGraphicsSetup.sense_hat` entry:

```js
'sense_hat': function(config, $target) {
  var url = trinketConfig.prefix('/js/embed/sense_hat.js');
  $target.data("graphicMode", "sense_hat");
  return loadExternalLibraryInternal_(url, true).then(function() {
    return SenseHat.init(config, $target);   // installs Sk.sense_hat + emit, renders
  });
}
```

No changes to `python.html`, the `skulpt_js` bundle lists, or config — the
component is fetched on demand by script injection when (and only when) a
trinket imports `sense_hat`.

### New component — `public/js/embed/sense_hat.js`

A self-contained `SenseHat` global (mirrors `Pygame`/`ProcessingSk`) exposing
`init(config, $target)`. It owns all state, DOM, styles, and teardown.

**On `init`:**

1. Tear down any prior instance (`Sk.sense_hat && Sk.sense_hat._destroy?.()`)
   for idempotent re-runs.
2. Inject the component `<style>` once.
3. Create a fresh `Sk.sense_hat`:
   ```js
   { pixels: [], low_light: false, gamma: [/* 32 zeros */],
     rtimu: {/* default valid readings */}, sensestick: makeStick(),
     _destroy: fn }
   ```
   (The bridge's `init()` refills `pixels`/`gamma`/`rtimu`; we seed them anyway
   for safety and to render a blank grid immediately.)
4. Install `Sk.sense_hat_emit` handling the five events above.
5. Build DOM into `$target`: a `<canvas>` LED matrix sized `min(w, h)` and a
   5-button D-pad; wire keyboard + pointer input.

**LED matrix (canvas).** 8×8 rounded "LEDs" on a dark board background; full
repaint on `init`/`setpixels`, single-cell repaint on `setpixel`. A dim factor
is applied when `low_light` is true. *(Decision: canvas over 64 `<div>`s — crisp
glow, cheap whole-buffer repaint. Localised; swappable.)*

**Tiny EventEmitter (`makeStick`).** ~20 lines providing `_eventQueue`,
`_threadHandler`, and `on/once/off/emit` with the `(eventName, data)` call
signature the bridge expects. No new dependency.

**Joystick input.**

- On-screen D-pad: 5 buttons (up/down/left/right/centre) rendered in `$target`.
- Keyboard: listeners on the `#graphic` target; arrows + Enter, `preventDefault`
  to stop page scroll. The interactive embed already makes `#graphic` focusable
  (`role="application" tabindex="0"`); the output-only variant is a bare
  `<div>`, so `init` sets `tabindex`/`role` on the target if missing and focuses
  it.
- `keydown`/pointerdown → push `state:1` (PRESS); OS auto-repeat
  (`event.repeat`) → `state:2` (HOLD); `keyup`/pointerup → `state:0` (RELEASE).
  Each push appends to `sensestick._eventQueue` and
  `emit('sensestick.input', { type: 'keydown' })`.

### Data flow (round trip)

```
from sense_hat import SenseHat
  → Sk.onBeforeImport('sense_hat')
      → graphicsSetup.sense_hat: lazy-load sense_hat.js, SenseHat.init()
          → installs Sk.sense_hat (+ sensestick) and Sk.sense_hat_emit, paints blank grid
s = SenseHat()            → bridge init()          → emit('init')      → repaint
s.set_pixels([...])       → writes Sk.sense_hat.pixels, emit('setpixels') → repaint
[learner presses ↑ / D-pad up]
  → push {ts,103,1,1} to _eventQueue, emit('sensestick.input')
      → Python stick.wait_for_event()/get_events() resolves → InputEvent(direction='up', action='pressed')
```

## Error / edge handling

- **Blocking joystick reads + Stop.** `_wait`/`_read` are Promise-suspensions
  that resolve only on input, so a program parked in `wait_for_event()` is not
  broken by Skulpt's normal interrupt poll. The component hooks the run/abort
  lifecycle to `emit('sensestick.input', { type: 'keyboardinterrupt' })` so Stop
  cleanly aborts a blocked read.
- **Idempotent re-runs.** Each `init` runs the stored `_destroy` (removes DOM +
  detaches listeners) and resets `pixels`, so re-running or switching trinkets
  never leaks listeners or stacks canvases.
- **Single graphics library at a time** is inherited free from the existing
  mechanism (can't mix turtle/pygame/sense_hat).
- **Unwired sensors.** `get_temperature()` etc. are not fed; the bridge's own
  range-checks return "invalid" defaults instead of throwing. Acceptable — 0
  trinkets read sensors.

## Testing

- **Automated (mocha / chai / sinon, no DOM).** The embed scripts have no
  front-end DOM test harness today, and adding one (jsdom + canvas mock) is out
  of scope. Keep the pure logic in small exported functions and unit-test them
  against a mock `Sk`:
  - the `sensestick` emitter — `on/once/off/emit` semantics + queue ordering;
  - key/pointer → `{timestamp, key, state, type}` mapping (codes + states);
  - the emit → render-model transform (pixels → per-cell colour, incl.
    `low_light` dim maths).
  Canvas/DOM rendering itself is not unit-tested.
- **Manual browser verification** (via the `verify`/`run` skills at
  implementation):
  - reported trinket `50f94b45cc0c` renders the logo animation loop;
  - a joystick trinket from Kat's list responds to arrows **and** the D-pad;
  - `low_light = True` visibly dims;
  - Stop aborts a program blocked in `wait_for_event()`.

## Reference

- Verified contract source: `src/lib/_internal_sense_hat.js`, `sense_hat/stick.py`,
  `sense_hat/hat.py` inside the deployed `…-skulpt-stdlib.js`.
- Behavioural reference only (not code to port): the Raspberry Pi Foundation
  Sense HAT web emulator and trinket.io's own working deployment.
- Existing pattern to copy: the `processing` / `pygame` lazy-load wiring in
  `public/js/skulpt/wrapper.js`.
