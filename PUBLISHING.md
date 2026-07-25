# Publishing to the Chrome Web Store

Checklist for submitting the **FPL Fixtures & xP** extension (v1.0.5) to the Chrome Web Store.  
The packaged zip is ready at `dist/fpl-fixtures-xp-1.0.5.zip` (34 KB, 14 files).

## 1. What you have to do yourself

* **Create a Chrome Web Store developer account** – a one-time **$5 USD registration fee** paid through Google.
* You must **accept the developer agreement** and **sign in with your own Google account**.
* **Nobody can do this on your behalf** – the account is permanently tied to you.

## 2. Steps

1. Go to the Chrome Web Store Developer Dashboard:  
   <https://chrome.google.com/webstore/devconsole>
2. Click **Add new item**.
3. Upload the zip file `dist/fpl-fixtures-xp-1.0.5.zip`.
4. Fill in the listing details (see **Listing copy** below).
5. Upload the required screenshots (see **Required assets**).
6. Answer the privacy & permissions questions (see **Privacy and permissions answers**).
7. Click **Submit for review**.

**Review time** – typically a few days; first submissions may take longer.

## 3. Listing copy you can paste

### Short description (must be ≤ 132 characters)

```
Adds the next 5 fixtures (colour-coded by FDR) and an expected-points estimate for the current gameweek to every FPL player.
```

### Detailed description (~150 words)

```
FPL Fixtures & xP enhances your Fantasy Premier League experience directly on the Pick Team page.

Features:
• Next-5 fixture strip under every player, colour-coded by the official Fixture Difficulty Rating (dark-green = easy → dark-red = hard). Blanks and double gameweeks are clearly marked.
• Expected points (xP) for the current gameweek displayed on each player’s card.
• Hover over the badge for a full breakdown: per-fixture expected points, expected minutes, and FDR.
• Popup with three tabs:
   – “My squad” – automatically detects your manager ID from your signed-in session and shows your team’s fixture strips and xP.
   – “Top xP” – league-wide table of the 40 highest-expected-point players, filterable by position and price, sortable by xP or xP per £m.
   – “Settings” – toggle the xP badge and the fixture strip, and choose how many fixtures to show.
• All data comes from the public Fantasy Premier League API – no scraping or hidden calls.

This extension is not affiliated with or endorsed by the Premier League or Fantasy Premier League.
```

Set **Category** to *Sports* and **Language** to English in the dashboard fields.

## 4. Required assets you must create

### Screenshots
At least one screenshot is required.  
- Dimensions: **1280×800** or **640×400** (PNG or JPEG)  
- **You must capture these from your own browser** on your actual Pick Team page while the extension is running (so the reviewer sees the overlay in action).  
- Suggested shots: one of the Pick Team page with fixture strips and xP badges visible, one of the popup showing the “Top xP” tab.

### Promo tile (optional)
- 440×280 PNG/JPEG – used in the store if you want a small promotional image.

## 5. Privacy and permissions answers

### Single purpose
The extension adds a next-5 fixture difficulty strip and an expected-points badge to players on Fantasy Premier League pages, and provides a popup with squad and league-wide xP information.

### Permission justifications

Paste these verbatim into the two boxes on the Privacy practices tab. Both are
within the 1,000 character limit.

**`storage` justification**

```
The extension uses chrome.storage.local for three things, all of which stay in the user's own browser:

1. Display preferences set in the extension popup: whether to show the expected-points badge, whether to show the fixture strip, and how many upcoming fixtures to display.

2. The user's own Fantasy Premier League manager ID, so the popup can show their squad without them having to re-enter it on every visit.

3. A short-lived cache of the public Fantasy Premier League API responses. The main player and team dataset is roughly 1.2 MB, so it is cached for 15 minutes and the fixture list for 60 minutes to avoid re-downloading the same public data on every page load.

Nothing stored is transmitted anywhere. The extension collects no personal information, no browsing history and no credentials.
```

**Host permission justification**

```
The extension requests access to https://fantasy.premierleague.com/* only, and needs it for two reasons.

1. Content script injection. The single purpose of the extension is to show each player's upcoming fixture difficulty and an expected-points estimate directly on the Fantasy Premier League site. It therefore has to run on that site in order to read the player names rendered on the page and insert the fixture strip and badge next to them.

2. Reading the public Fantasy Premier League JSON API, which is served from the same host: /api/bootstrap-static/ for players, teams and gameweeks; /api/fixtures/ for the fixture list and its difficulty ratings; /api/entry/{id}/ and /api/entry/{id}/event/{gw}/picks/ for the user's own squad; and /api/me/, which is read solely to obtain the signed-in user's own manager ID so they do not have to look it up and type it in.

No other host is contacted and no data is sent to any third-party server.
```

### Are you using remote code?

Answer **No**. The package contains no remote code: there is no `eval` and no
`new Function`, `popup.html` loads only local files, and the only two network
calls fetch `application/json` from the FPL API. Data returned over the network
is not remote code. Answering yes would be inaccurate and invites a stricter
review for something the extension does not do.

A host permission always triggers the "may require an in-depth review" warning.
That is expected and just means a slower review; `activeTab` is not an
alternative here, because the extension has to read the FPL API and run on page
load rather than on a click.

### Data usage disclosure
- The extension **collects no personal data** and **transmits nothing to any third party**.
- All data from the public FPL API is fetched directly from `fantasy.premierleague.com` only; no other hosts are contacted.
- The extension stores **only** display preferences and your manager ID in Chrome’s local storage – this data never leaves your device.
- The extension does **not** use remote code or `eval`.

### Manifest summary (for reference)

- `manifest.json` version: **3**
- Permissions: `["storage"]`
- Host permissions: `["https://fantasy.premierleague.com/*"]`
- No remote code, no `eval`, no external hosts beyond `fantasy.premierleague.com`

## 6. Before you resubmit an update

1. Increment the `"version"` field in `manifest.json` (e.g., `1.0.0` → `1.0.1`).
2. Rebuild the zip from the project root:

   ```bash
   zip -r dist/fpl-fixtures-xp-<version>.zip manifest.json src icons README.md -x '*.DS_Store'
   ```

3. Upload the new zip from the Developer Dashboard – each version goes through review again.
