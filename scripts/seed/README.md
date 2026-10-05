# Local seed data

Test accounts and one trinket per execution path, for manual testing against
the local Docker stack. Local only: the script refuses to run unless both the
database and the app URL (`app.url.hostname`) are local.

```sh
docker compose exec app npm run seed
```

Safe to re-run. Users and trinkets are matched by username and shortCode and
updated in place, so the URLs below never change. After editing a file in
`trinkets/`, re-run the seed and reload the page. To start from an empty
database: `docker compose down -v`, `docker compose up -d`, then seed again.

## Accounts

Both accounts get a new random password on every run. The seed prints it at
the end; the previous one stops working. (It's never written in the repo:
the repo is public, so a fixed password would be a known admin login.)

| Email | Role |
|---|---|
| `seedadmin@example.com` | admin (`/admin`) |
| `seedstudent@example.com` | ordinary user |

The trinkets are owned by `seedadmin`, but every URL works logged out.

## URLs

Each trinket has a **full page** (`/<lang>/<shortCode>`, the editor as a pupil
sees it) and an **embed** (`/embed/<lang>/<shortCode>`, the view that goes in
an iframe). Python 3 and pygame need the serverside stack running.

### Python 3

| What it tests | Full page | Embed | Expect |
|---|---|---|---|
| Output streaming | [/python3/seed-py3-hello](http://localhost:3000/python3/seed-py3-hello) | [embed](http://localhost:3000/embed/python3/seed-py3-hello) | Lines appear half a second apart, then "Done." |
| Traceback | [/python3/seed-py3-error](http://localhost:3000/python3/seed-py3-error) | [embed](http://localhost:3000/embed/python3/seed-py3-error) | First average prints, then ZeroDivisionError |
| `input()` and abandoned sessions | [/python3/seed-py3-input](http://localhost:3000/python3/seed-py3-input) | [embed](http://localhost:3000/embed/python3/seed-py3-input) | Asks two questions and replies |
| 60-second run limit | [/python3/seed-py3-loop](http://localhost:3000/python3/seed-py3-loop) | [embed](http://localhost:3000/embed/python3/seed-py3-loop) | Counts seconds, stops at about 60 |
| Output flood limit | [/python3/seed-py3-flood](http://localhost:3000/python3/seed-py3-flood) | [embed](http://localhost:3000/embed/python3/seed-py3-flood) | Numbers pour out, then cut off |
| matplotlib image | [/python3/seed-py3-plot](http://localhost:3000/python3/seed-py3-plot) | [embed](http://localhost:3000/embed/python3/seed-py3-plot) | Two-line chart, then "Plot drawn." |
| Two files + file output | [/python3/seed-py3-files](http://localhost:3000/python3/seed-py3-files) | [embed](http://localhost:3000/embed/python3/seed-py3-files) | Uppercase message, total 55, results.txt appears |
| Heavy imports | [/python3/seed-py3-pandas](http://localhost:3000/python3/seed-py3-pandas) | [embed](http://localhost:3000/embed/python3/seed-py3-pandas) | Versions, then a table with Dara first |

### Pygame

| What it tests | Full page | Embed | Expect |
|---|---|---|---|
| Animation over VNC | [/pygame/seed-pg-bounce](http://localhost:3000/pygame/seed-pg-bounce) | [embed](http://localhost:3000/embed/pygame/seed-pg-bounce) | Smooth balls; fps line every 5 s |
| Keyboard input | [/pygame/seed-pg-keys](http://localhost:3000/pygame/seed-pg-keys) | [embed](http://localhost:3000/embed/pygame/seed-pg-keys) | Click the window; arrow keys move the square |

### Browser-side (no server)

| What it tests | Full page | Embed | Expect |
|---|---|---|---|
| Skulpt Python + turtle | [/python/seed-py-turtle](http://localhost:3000/python/seed-py-turtle) | [embed](http://localhost:3000/embed/python/seed-py-turtle) | A coloured spiral |
| HTML + CSS + JS | [/html/seed-html-page](http://localhost:3000/html/seed-html-page) | [embed](http://localhost:3000/embed/html/seed-html-page) | Dark blue heading; button counter works |

Blank editors with nothing saved: [/embed/python3](http://localhost:3000/embed/python3),
[/embed/pygame](http://localhost:3000/embed/pygame).

## Abandoned-session tests (`seed-py3-input`)

1. **Abandoned tab:** press Run, then close the tab without answering. The
   waiting python process should be killed. Check nothing is left behind (no
   `python3` line mentioning `/tmp/sessions`):

   ```sh
   docker compose -f serverside/docker-compose.yml --profile python3 exec python3-shell ps -ef
   ```

2. **Left waiting:** press Run and don't answer. The 60-second run limit stops
   the program and the run ends.

The shell log shows what the shell did:

```sh
docker compose -f serverside/docker-compose.yml --profile python3 logs -f python3-shell
```

## Adding a trinket

1. Make a folder `trinkets/<shortCode>/` with `main.py` (`index.html` for
   HTML) plus any other files. Every file becomes a tab.
2. Add an entry to `manifest.js`. No dots in the shortCode: a dot is read as a
   file extension.
3. Re-run the seed. Its output prints the new URLs.
