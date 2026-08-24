# Sense HAT temperature slider (ENG-2289)

**Date:** 2026-08-24
**Linear:** [ENG-2289](https://linear.app/stem-learning/issue/ENG-2289)
**Status:** Implemented on branch `eng-2289-sensehat-add-slider-for-storing-value-for-temperature`

## Problem

Classroom worksheets (LT-450) prompt learners to type:

```python
from sense_hat import SenseHat
sense = SenseHat()
temperature = sense.get_temperature()
```

Our Sense HAT component (ENG-1887) deliberately left the environmental
sensors unwired: `Sk.sense_hat.rtimu.temperature` is seeded `[1, 0]`, so
`get_temperature()` always returns `0` and learners have no way to change
it. The OG trinket.io deployment showed three sliders above the emulator
(temperature / pressure / humidity); the ticket asks for the temperature
one.

## Verified contract (trinketapp/skulpt `_internal_sense_hat.js`, `sense_hat/hat.py`)

- `get_temperature()` → `get_temperature_from_humidity()` →
  `_ish.humidityRead()`, which internally calls `temperatureRead()` and
  returns `[humValid, humidity, tempValid, temperature]`.
- `temperatureRead()` reads `Sk.sense_hat.rtimu.temperature`, which must be
  a 2-element array `[valid, value]`. It re-validates on **every call**:
  non-numeric → invalid; value outside **−40…120 °C** → invalid (Python
  then yields `0`); otherwise returns `[1, value]`.
- Reads are live — updating `rtimu.temperature` mid-run changes what the
  next `get_temperature()` call returns. No emit/repaint involvement.
- Same shape applies to `rtimu.humidity` (valid ≥ 0) and `rtimu.pressure`
  (valid 260…1260 mbar) — relevant only for future extension.

## Design

All changes live in `public/js/embed/sense_hat.js` (the lazy-loaded
component). No wrapper, template, or config changes.

- **`SENSOR_SPECS`** — table keyed by sensor name:
  `{ temperature: { min: -40, max: 120, step: 1, unit: '° C', icon: '🌡' } }`.
  Only temperature is wired now (YAGNI — the ticket asks for temperature;
  0 known trinkets read pressure/humidity). Adding another slider later is
  one spec entry, because everything below is parameterised by name.
- **Pure helpers** (exported for unit tests):
  - `clampSensorValue(name, raw)` → number clamped to the spec range, or
    `null` for non-numeric input (leaves state untouched).
  - `applySensorValue(state, name, raw)` → clamps, writes
    `state.rtimu[name] = [1, value]`, returns the applied value.
  - `formatSensorReadout(name, value)` → OG-style readout, e.g. `25° C`.
- **UI**: a slider row (`icon | <input type=range> | readout`) inserted
  above the LED canvas inside `.sense-hat`, one row per spec entry.
  `input` events apply the value to `Sk.sense_hat.rtimu` and refresh the
  readout. `aria-label="temperature"` on the input; native range-input
  keyboard support gives arrow-key adjustment for free.
- **Default 25 °C**, persisted across re-runs in module scope
  (`sensorValues`) so a learner's setting survives Run being pressed again
  within the same page. (Changes the default reading from 0 → 25; nothing
  depended on 0 — the sensor was previously unusable.)
- **Keyboard conflict guard**: the component's root `keydown`/`keyup`
  joystick handlers now ignore events originating from `INPUT` elements —
  otherwise arrows on a focused slider would fire joystick events and
  `preventDefault()` would stop the slider moving.
- **CSS**: component owns every property Foundation's bare `input`/`label`
  rules could bleed into (margin, width, display, color, font-size), per
  the ENG-2261 lesson. Styling matches the existing dark component look.

## Alternatives considered

1. **Sliders in the embed chrome outside `#graphic`** — needs template
   changes and leaks Sense HAT specifics into the generic embed. Rejected.
2. **All three OG sliders now** — identical machinery, but adds permanent
   UI clutter above every LED-only trinket (10/10 current trinkets don't
   read sensors) for a need no worksheet has. Spec-table design keeps the
   cost of adding them later at ~3 lines each. Rejected for now.

## Testing

- Unit (mocha, no DOM): spec-table shape matches the bridge's valid range;
  clamp maths incl. out-of-range and non-numeric input; `applySensorValue`
  writes the `[1, value]` shape; readout formatting.
- Manual browser: route-inject the local `sense_hat.js` over the deployed
  embed (per the established Playwright technique), run the worksheet
  snippet in a loop, drag the slider, confirm printed temperature follows
  it live, joystick arrows still work, slider survives re-run.
