# Plasma Cut

A JezzBall-style containment game. Portrait, touch-first, no frontend dependencies
and no build step for the game itself — open `index.html` (via a local server) and
it runs. The public leaderboard is served by Netlify Functions (Netlify Blobs by
default, or Supabase when `SUPABASE_*` env vars are set).

```
index.html              screens & HUD markup
styles.css              all UI chrome (the playfield itself is canvas-drawn)
game.js                 engine: grid, physics, wall growth, flood-fill capture, render
netlify.toml            Netlify publish + functions config
netlify/functions/      leaderboard GET + score POST
supabase/schema.sql     scores table DDL
```

## Run locally (game only)

Any static server (needed because browsers restrict `file://` for fonts):

```
python3 -m http.server 8000    # → http://localhost:8000
```

Leaderboard calls hit `/.netlify/functions/*`, so for full local API testing:

```
netlify dev
```

Desktop testing shortcuts: `H` / `V` flip the cut axis, `Esc` pauses.

## Deploy (Netlify)

Live site: https://plasma-cut.netlify.app  
Repo: https://github.com/rp779/plasma-cut

Scores work out of the box on Netlify via **Netlify Blobs**. Optionally point the
same API at **Supabase** (recommended before iOS auth) by setting env vars.

### Netlify

- Publish directory: `.` (from `netlify.toml`)
- Functions: `netlify/functions`
- Optional env vars (switch storage to Supabase):
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`

### Supabase (optional)

1. Create a project at [supabase.com](https://supabase.com).
2. In the SQL editor, run [`supabase/schema.sql`](supabase/schema.sql).
3. Set the two env vars above on the Netlify site and redeploy.

### Smoke test

1. Open the site → play → clear a level → enter a nickname → **SUBMIT SCORE**.
2. Open **SCORES** on the title screen and confirm the entry appears.
3. `GET /.netlify/functions/leaderboard` should return JSON `{ "scores": [...] }`.

## Leaderboard rules

- Submit after **any level clear** with a nickname (2–16 chars: letters, numbers, spaces, `_`).
- One public row per nickname; only a **higher** score replaces the previous.
- Top 50 scores are shown on the **SCORES** screen.
- Local unlock progress and personal best still use `localStorage` (`plasmacut.v1`).

## Tuning

Top of `game.js`:

| Constant | Default | Effect |
| --- | --- | --- |
| `COLS`, `ROWS` | 27 × 45 | Field resolution. Cell size is derived from the viewport. |
| `WALL_STEP_MS` | 14 | Ms per cell of wall growth — lower is faster, and harder. |
| `LIVES` | 3 | Lives per level. |
| `MAX_LEVEL` | 12 | Level count on the select screen. |
| `ACCENT`, `ORB` | cyan / magenta | Palette. Mirror any change into the `:root` block in `styles.css`. |

Per-level difficulty lives in `startLevel()`: orb count is `level + 1` (max 9),
speed is `1.5 + level * 0.11` scaled to cell size, and the capture target is
`70 + level` percent (`target()`).

## Scoring

- 8 per captured cell, plus a 60 bonus per successful capture event
- On clear: `max(0, 90 - seconds) * 12` time bonus, plus 250 per remaining life
- Unlocked level and best score persist in `localStorage` under `plasmacut.v1`
- Public board entries are stored in Supabase via Netlify Functions

## iOS (Phase 2)

Not wired yet. Planned path: Capacitor wrap of this same web app, plus Sign in
with Apple / Google for authenticated scores. The layout already respects
`env(safe-area-inset-*)` and the meta viewport uses `viewport-fit=cover`.

Legacy WKWebView notes still apply if you embed the static files directly:

```swift
let url = Bundle.main.url(forResource: "index", withExtension: "html")!
webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
```

Set `scrollView.bounces = false`, and in the config `allowsInlineMediaPlayback = true`.
