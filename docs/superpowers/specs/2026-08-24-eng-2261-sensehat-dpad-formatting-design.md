# ENG-2261 — Sense HAT D-pad formatting (overlap + contrast)

Date: 2026-08-24
Ticket: [ENG-2261](https://linear.app/stem-learning/issue/ENG-2261/sensehat-format-joystick-buttons-better)
Branch: `eng-2261-sensehat-format-joystick-buttons-better`

## Problem

The Sense HAT joystick D-pad (added in ENG-1887) renders badly on the embed
page (see ticket screenshot):

1. The left / centre / right buttons overlap each other horizontally.
2. The arrow/dot glyphs are white on a near-white button — almost invisible.

## Root cause

The embed page ships Foundation, whose bare `button, .button` rule
(`public/css/embed/foundation.css:1235`) applies to the D-pad buttons:

- `padding: 1rem 2rem 1.0625rem 2rem` — each button's min-content width far
  exceeds its fixed 40px grid track, so grid items overflow and visually
  overlap. This is the sole cause of the overlap; the grid geometry itself
  (3×40px tracks, 4px gap) is fine.
- `margin: 0 0 1.25rem` — stray bottom margin per button.
- `color: white` — `.sense-hat-dpad-btn` sets `background:#f4f4f4` but not
  `color`, so Foundation's white text wins → white glyphs on a light button.
- `button:hover, button:focus { background-color:#006ecc; color:white }` —
  specificity 0-1-1 beats the component's 0-1-0 class rule, so buttons flash
  Foundation blue on hover.

## Fix (chosen approach)

Harden `.sense-hat-dpad-btn` in `SENSE_HAT_CSS`
(`public/js/embed/sense_hat.js`) so every property Foundation sets is
explicitly owned by the component:

- `margin:0; padding:0` — buttons fit their 40px tracks; no more overlap.
- Dark scheme per the ticket's "make button background darker": `#333`
  background, `#fff` glyphs (contrast ≈ 12.6:1), `#1a1a1a` border. Matches
  the dark LED-matrix board above.
- Grid gap 4px → 6px for a little extra separation ("move the buttons
  further apart").
- Glyph size 14px → 16px for legibility.
- `.sense-hat-dpad .sense-hat-dpad-btn:hover/:focus/:active` states
  (specificity 0-2-1) so Foundation's 0-1-1 hover rule can never win,
  regardless of stylesheet order: hover/focus `#4d4d4d`, active `#606060`.
- Short background transition (60ms) so press feedback feels immediate
  (Foundation's 300ms fade is sluggish for a game pad).

## Alternatives rejected

- `all: revert` on the buttons — heavy-handed; reverts UA styles too and
  interacts unpredictably with the grid item display.
- Replace `<button>` with styled `<div role=button>` — loses native keyboard
  semantics and accessibility for no benefit.

## Testing

- CSS string is not unit-testable; existing pure-helper mocha suite
  (`test/lib/embed/sense_hat.js`) must still pass (module load regression).
- Visual verification against the deployed embed via headed Playwright
  Chrome with the local `sense_hat.js` route-injected over the live one
  (technique proven on ENG-2283), trinket `50f94b45cc0c`.
