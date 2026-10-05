/**
 * The seeded test trinkets. Each entry's code lives in trinkets/<shortCode>/;
 * every file in that folder becomes a tab, main file first.
 *
 * shortCodes are fixed so the URLs never change across re-seeds and resets.
 * Keep them free of dots: helpers.findTrinket treats ".x" as a file extension.
 */
module.exports = [
  // Python 3: server-side, through nginx -> python3-manager -> python3-shell
  {
    shortCode : 'seed-py3-hello',
    lang      : 'python3',
    name      : 'Seed: hello (output streaming)',
    check     : 'Lines appear one at a time, half a second apart, then "Done."',
  },
  {
    shortCode : 'seed-py3-error',
    lang      : 'python3',
    name      : 'Seed: error (traceback)',
    check     : 'First average prints, then a ZeroDivisionError traceback into average().',
  },
  {
    shortCode : 'seed-py3-input',
    lang      : 'python3',
    name      : 'Seed: input (and abandoned sessions)',
    check     : 'Asks two questions and replies. Close the tab mid-question: no python process is left behind.',
  },
  {
    shortCode : 'seed-py3-loop',
    lang      : 'python3',
    name      : 'Seed: infinite loop (60s run limit)',
    check     : 'Counts seconds, then stops at about 60 seconds.',
  },
  {
    shortCode : 'seed-py3-flood',
    lang      : 'python3',
    name      : 'Seed: output flood (emit limit)',
    check     : 'Numbers pour out, then the session is cut off within a moment.',
  },
  {
    shortCode : 'seed-py3-plot',
    lang      : 'python3',
    name      : 'Seed: matplotlib plot',
    check     : 'A two-line chart appears, then "Plot drawn."',
  },
  {
    shortCode : 'seed-py3-files',
    lang      : 'python3',
    name      : 'Seed: two files + file output',
    check     : 'Uppercase message, total 55, and results.txt appears as a new file.',
  },
  {
    shortCode : 'seed-py3-pandas',
    lang      : 'python3',
    name      : 'Seed: heavy imports (pandas)',
    check     : 'Import time, versions, then a table sorted by average (Dara first).',
  },

  // Pygame: server-side, game window streamed over VNC
  {
    shortCode : 'seed-pg-bounce',
    lang      : 'pygame',
    name      : 'Seed: pygame bouncing balls',
    check     : 'Smooth animation in the game window; an fps line prints every 5 seconds.',
  },
  {
    shortCode : 'seed-pg-keys',
    lang      : 'pygame',
    name      : 'Seed: pygame arrow keys',
    check     : 'Click the game window; arrow keys move the square and print each move.',
  },

  // Browser-side, no server involved
  {
    shortCode : 'seed-py-turtle',
    lang      : 'python',
    name      : 'Seed: Skulpt turtle',
    check     : 'A coloured spiral is drawn, then "Spiral finished."',
  },
  {
    shortCode : 'seed-html-page',
    lang      : 'html',
    name      : 'Seed: HTML + CSS + JS',
    check     : 'Dark blue heading (CSS loaded); the button counter goes up (JS loaded).',
  },
];
