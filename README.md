# FPL Fixtures & xP – Chrome Extension

Adds a next‑5‑fixtures strip colour‑coded by Fixture Difficulty Rating and a current‑gameweek expected‑points (xP) badge to every player on fantasy.premierleague.com.  
A popup also shows your squad’s xP breakdown and a league‑wide **Top xP** table (requires just your numeric manager ID).

---

## Install

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Turn on **Developer mode** (top‑right toggle).
4. Click **Load unpacked** and select the project folder.
5. The extension icon appears in the toolbar – no further setup.

---

## Usage

- **Overlay** – visit `https://fantasy.premierleague.com` (any page).  
  Every player card gets an xP badge in its top‑right corner and a colour‑coded
  fixture strip along the bottom. Hover either one for a breakdown.
- **Popup** – click the toolbar icon.  
  The popup has three tabs:

  | Tab | What it shows |
  |-----|---------------|
  | **My squad** | Your 15 players with their modelled xP, next 5 fixtures, and FDR colours. Your **manager ID** is filled in automatically — see below. |
  | **Top xP** | The 40 highest‑xP players for the current gameweek, filterable by position and price, sortable by xP or xP per £m. |
  | **Settings** | Toggle the xP badge and fixture strip, change how many fixtures to show, and force‑refresh the cached FPL data. |

> **You do not normally need to enter a manager ID.** While you are signed in to
> FPL, the content script reads it from `/api/me/` and stores it, so the popup is
> ready the first time you open it. It falls back to an `/entry/<id>/` URL if you
> are browsing one. You can still type an ID in to inspect someone else's team —
> a value you enter yourself is never overwritten.
>
> The **on-page overlay never needs a manager ID at all**: it reads the players
> straight from the page.

---

## File layout

| File | Role |
|------|------|
| `manifest.json` | Extension manifest (Manifest V3). Declares permissions, content script, popup, and icons. |
| `src/background.js` | Service worker. **Only** component that calls FPL APIs. Caches `bootstrap-static/` (15 min) and `fixtures/` (60 min) in `chrome.storage.local`. |
| `src/xp.js` | Shared expected‑points model and fixture helpers. Exposes `window.FPLXP`. |
| `src/content.js` | DOM overlay logic – injects fixture strips and xP badges on FPL pages. |
| `src/content.css` | Styles for the injected overlays (FDR chips, xP badge, tooltips). |
| `src/popup.html` | Popup markup (tabs, table, settings form). |
| `src/popup.css` | Popup‑only styles. |
| `src/popup.js` | Popup logic – requests data from the service worker, renders the squad / Top xP / Settings tabs. |
| `icons/` | Icon set at 16, 48, and 128 pixels. |

---

## How xP is calculated

1. **Expected minutes**  
   Uses a player’s `starts` and `minutes` divided by their team’s games played, scaled by `chance_of_playing_next_round`. Results: `xMins`, probability to start, probability to reach 60 min, and probability to appear at all.

2. **Per‑90 rates** (goals, assists, saves, defensive contributions, bonus, cards)  
   Prefer `expected_goals_per_90` / `expected_assists_per_90` when present; otherwise derive a rate from actual output. A rate needs at least 90 minutes of data to be computed at all — below that the term is dropped, except goalkeeper saves and bonus, which use a flat prior.

3. **Fixture goal expectations**  
   If FPL’s `strength_attack_*` / `strength_defence_*` team ratings are populated (>75% of teams), combine them with home‑advantage constants (`BASE_GOALS_HOME = 1.55`, `BASE_GOALS_AWAY = 1.25`) to project xG and xGC.  
   During the off‑season all ratings are 0; the model then falls back to the per‑fixture **FDR** number, using fixed multipliers for attack and goals‑conceded.

4. **Appearance & clean‑sheet points**  
   Appearance points (1 or 2) are awarded from the minutes model.  
   Clean‑sheet probability is calculated as `exp(-xGC)`; points only count if the player is on the pitch at 60 min.

5. **Poisson model for goals‑conceded penalty**  
   For GKs and DEF: expected penalty units = `E[floor(X/2)]` where `X ~ Poisson(xGC)`, giving `–1` point per 2 goals conceded.

6. **Other points**  
   Saves (1 pt / 3 saves), penalty saves (5 pts), defensive‑contribution bonus (2 pts, threshold varies by position), empirical bonus/90, yellow cards (–1) and red cards (–3). All scale with expected minutes; attacking returns and bonus are additionally scaled by the fixture's attack multiplier, and defensive contributions by expected goals conceded.

7. **Double & blank gameweeks**  
   In a double gameweek the model sums the xP from each separate fixture; blank gameweeks return 0.  
   A double gameweek shows as two underlined chips for the same gameweek and is called out in the hover tooltip; a blank shows as a grey `—` chip.

8. **Blending with FPL’s own estimate**  
   `element.ep_this` (or `ep_next` when `ep_this` is null) is used as a reference.  
   - Under **90 minutes** of data: xP = the FPL estimate (scaled for a double gameweek).  
   - 90–450 minutes: linear blend between the model and the scaled FPL estimate.  
   - >450 minutes: fully trust the model.  
   - Players FPL flags as out (`status` of `u`/`n`/`s`, or a 0% chance of playing) score 0 regardless of the blend. Availability comes from those flags only — never from how little history a player has, so a new signing with no minutes falls back to the FPL estimate rather than a confident 0.

---

## Known limitations

- **FPL does not publish real xP** – this is an estimate based on publicly available data.  
- **On‑page overlays** depend on FPL's markup. Nothing keys off FPL's hashed class names: the overlay finds player names in text nodes, then walks up to the smallest enclosing element that also carries the card's opponent line (`BOU (H)`), which also verifies *which* player a shared surname refers to. If that shape changes the overlay quietly does nothing rather than misfiring. The popup is unaffected.  
- **Squad visibility** – the `entry/{id}/event/{gw}/picks/` endpoint only returns data *after* a gameweek has kicked off. Before GW1 the **My squad** tab cannot display anything (it shows a helpful message).  
- **Authentication** – the extension never calls the `my-team/` endpoint (requires login cookies). The popup only needs your public manager ID.  
- **Carry‑over last season data** – when no gameweeks have been played and `ep_this` is null, the model relies on `ep_next` and per‑90 rates from the previous season, which may be misleading for newly promoted teams or players who switched clubs.

---

## API endpoints used

| Endpoint | Purpose |
|----------|---------|
| `bootstrap-static/` | Players, teams, events, element types, game settings. |
| `fixtures/` | All remaining fixtures with difficulties and stats. |
| `entry/{id}/` | Manager name, favourite team, league info. |
| `entry/{id}/event/{gw}/picks/` | The 15 players in a manager’s squad for a given gameweek. |
| `me/` | The signed-in manager’s own entry id, so the popup needs no manual input. Needs the session cookie, so it is called from the content script rather than the service worker; returns `{"player": null}` when signed out. |

---

## Development

There is no build step — the extension is plain ES5-compatible JavaScript, so
`Load unpacked` reloads pick up edits directly. After editing `src/background.js`
hit the reload icon on `chrome://extensions` to restart the service worker.

The model in `src/xp.js` is deliberately free of DOM and extension APIs so it can
be exercised headlessly against a snapshot of the real API:

```bash
curl -s https://fantasy.premierleague.com/api/bootstrap-static/ > bootstrap.json
curl -s https://fantasy.premierleague.com/api/fixtures/ > fixtures.json
node -e '
  const fs = require("fs"), self = {};
  new Function("self", fs.readFileSync("src/xp.js", "utf8"))(self);
  const ctx = self.FPLXP.buildContext(
    JSON.parse(fs.readFileSync("bootstrap.json")),
    JSON.parse(fs.readFileSync("fixtures.json")));
  console.log("target GW", ctx.targetGw, "| strength ratings usable:", ctx.averages.usable);
'
```

---

## Troubleshooting the overlay

Open DevTools on an FPL page. On load the extension logs:

```
[FPL xP] ready — target GW1 (run __fplxp.report() to diagnose)
[FPL xP] annotated 15 player cards
```

If badges are missing, run `__fplxp.report()` in the console. It returns the
target gameweek, how many player names were found in the page, how many cards
were annotated, and a sample showing — for the first few names — which element
was chosen as the card and whether its opponent line was parsed:

```js
__fplxp.report()
// { ready: true, targetGw: 1, nameNodesFound: 15, annotatedNow: 15,
//   sample: [{ name: "Haaland", cardTag: "DIV.ElementWrap-sc-…",
//              opponentTokens: [{ short: "bou", venue: "h" }] }] }
```

- `ready: false` — the FPL API call failed. Check `debug.lastError`, and reload
  the service worker from `chrome://extensions`.
- `nameNodesFound: 0` — no player names were recognised in the page text.
- names found but `annotatedNow: 0` — the cards were located but rejected. An
  empty `opponentTokens` with no shirt or photo image in the card means there was
  no evidence the container is a player card.

`__fplxp.rescan()` clears every annotation and re-runs the scan.
