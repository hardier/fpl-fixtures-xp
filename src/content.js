/*
 * Injects an xP badge and a fixture strip onto every player card FPL renders.
 *
 * FPL is a React app with hashed styled-components class names, so nothing here
 * relies on a class name or on any particular element being an <img>. The anchor
 * is the player's name in a text node: names are matched against
 * bootstrap-static, then we walk up to the smallest enclosing element that also
 * carries the card's opponent line ("BOU (H)"), which is what FPL prints under
 * every player. That line doubles as a check on *which* player a shared surname
 * refers to, because it must match one of that player's real fixtures.
 *
 * If the markup changes shape the worst case is that nothing is annotated — the
 * popup is unaffected.
 */
(function () {
  'use strict';

  var TAG = '[FPL xP]';
  var ANNOTATED = 'data-fplxp';

  // Longest web_name in the game is well under this; keeps the text scan cheap.
  var NAME_MAX_LEN = 34;
  // How far up from the name to look for the card container.
  var MAX_WALK_UP = 6;
  // Text longer than this cannot be a single player's card.
  var CARD_TEXT_MAX = 160;
  // Vertical room needed above the name before a corner badge is safe.
  var BADGE_CLEARANCE = 14;

  /**
   * Pages that show player cards. Everywhere else on the site is left alone —
   * league tables in particular are full of managers' real names, and FPL has
   * players called King, Kevin and Henry, so scanning them produced badges on
   * people rather than footballers.
   */
  var PLAYER_PAGES = [
    /^\/my-team/,
    /^\/transfers/,
    /^\/squad-selection/,
    /^\/statistics/,
    /^\/entry\/\d+\/event\/\d+/
  ];

  var ctx = null;
  var nameIndex = null;   // normalised name -> [player, ...]
  var benignTokens = {};  // words allowed to sit beside a player's name
  var photoIndex = null;  // photo id -> player
  var compactNames = [];  // space-free name keys, longest first
  var settings = { showXp: true, showFixtures: true, fixtureCount: 5 };
  var scheduled = null;

  var debug = {
    ready: false,
    scans: 0,
    annotated: 0,
    nameHits: 0,
    cardsRejected: 0,
    skippedPage: null,
    lastError: null
  };

  // ------------------------------------------------------------------ helpers

  function normalise(s) {
    return String(s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // strip accents: Sánchez -> Sanchez
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function buildIndexes(bootstrap) {
    nameIndex = {};
    photoIndex = {};
    benignTokens = {};

    // Words that legitimately sit next to a player's name on a card: their club,
    // their position, and the home/away marker. Anything else alongside a name
    // means we are probably not looking at a player at all.
    bootstrap.teams.forEach(function (t) {
      benignTokens[normalise(t.short_name)] = true;
      benignTokens[normalise(t.name)] = true;
    });
    (bootstrap.element_types || []).forEach(function (p) {
      if (p.singular_name_short) benignTokens[normalise(p.singular_name_short)] = true;
    });
    ['sub', 'gk', 'gkp', 'def', 'mid', 'fwd', 'xp', 'pts'].forEach(function (t) {
      benignTokens[t] = true;
    });

    bootstrap.elements.forEach(function (p) {
      [p.web_name, p.second_name, p.first_name + ' ' + p.second_name].forEach(function (raw) {
        if (!raw) return;
        var key = normalise(raw);
        if (!key || key.length < 2) return;
        if (!nameIndex[key]) nameIndex[key] = [];
        if (nameIndex[key].indexOf(p) === -1) nameIndex[key].push(p);
      });

      if (p.photo) photoIndex[String(p.photo).replace(/\.\w+$/, '')] = p;
    });

    // Space-free keys for the run-together fallback, longest first so that
    // "alexanderarnold" is tried before "arnold". Four characters is the floor:
    // it keeps real names like Raya, Kane and Sels while excluding fragments too
    // short to identify anyone. Matches found this way are inexact, so the
    // caller still requires card evidence before using them.
    compactNames = Object.keys(nameIndex)
      .map(function (k) { return { compact: k.replace(/ /g, ''), key: k }; })
      .filter(function (e) { return e.compact.length >= 4; })
      .sort(function (a, b) { return b.compact.length - a.compact.length; });
  }

  /**
   * Element text, or null when it is too long to be one player's card.
   *
   * Must not use `textContent`: FPL puts the name and the opponent in separate
   * divs, and concatenating them gives "DonnarummaBOU (H)" — where "BOU" is no
   * longer a separate word, so the opponent line stops being detectable. Collect
   * text nodes and join them with spaces instead, skipping our own output.
   */
  function cardText(el) {
    if ((el.textContent || '').length > CARD_TEXT_MAX) return null;

    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var parts = [];
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      if (parent && /^fplxp-/.test(parent.className || '')) continue;
      var t = (node.nodeValue || '').trim();
      if (t) parts.push(t);
    }
    return parts.join(' ');
  }

  /**
   * Opponent references in a card, e.g. "BOU (H)" / "hul (a)".
   *
   * Note `normalise` has already stripped the brackets, so this runs against
   * "bou h". Two entries appear in a double gameweek.
   */
  function opponentTokens(norm) {
    var out = [];
    var re = /\b([a-z]{3}) ([ha])\b/g;
    var m;
    while ((m = re.exec(norm))) out.push({ short: m[1], venue: m[2] });
    return out;
  }

  /** Real fixtures for this player in the target gameweek, as "bou h" tokens. */
  function playerFixtureTokens(player) {
    var list = (ctx.byTeamGw[player.team] || {})[ctx.targetGw] || [];
    return list.map(function (f) {
      var opp = ctx.teamsById[f.opponentId];
      return {
        short: opp ? opp.short_name.toLowerCase() : '',
        venue: f.isHome ? 'h' : 'a'
      };
    });
  }

  function tokensAgree(cardTokens, playerTokens) {
    for (var i = 0; i < cardTokens.length; i++) {
      for (var j = 0; j < playerTokens.length; j++) {
        if (cardTokens[i].short === playerTokens[j].short &&
            cardTokens[i].venue === playerTokens[j].venue) return true;
      }
    }
    return false;
  }

  function shirtTeamCodes(el) {
    var codes = [];
    var imgs = el.querySelectorAll ? el.querySelectorAll('img') : [];
    for (var i = 0; i < imgs.length; i++) {
      var src = imgs[i].getAttribute('src') || '';
      var shirt = src.match(/shirt[_-]?(\d+)/i);
      if (shirt) codes.push(parseInt(shirt[1], 10));
    }
    return codes;
  }

  function photoPlayer(el) {
    var imgs = el.querySelectorAll ? el.querySelectorAll('img') : [];
    for (var i = 0; i < imgs.length; i++) {
      var src = imgs[i].getAttribute('src') || '';
      // Anchored to FPL's player-photo path: a bare /p<digits>.png pattern
      // matches plenty of unrelated assets.
      var m = src.match(/photos\/players\/[^/]*\/p(\d+)\.(?:png|jpg|jpeg|webp)/);
      if (m && photoIndex[m[1]]) return photoIndex[m[1]];
    }
    return null;
  }

  /**
   * How many players a chunk of text names — used to reject a container that
   * wraps a whole row of players rather than one card.
   *
   * Counts non-overlapping occurrences, longest match first. Counting index keys
   * instead would double-count a single player, because "gibbs white" also
   * matches "white" and "b fernandes" also matches "fernandes".
   */
  function nameMatchCount(norm) {
    var words = norm.split(' ');
    var count = 0;
    var i = 0;

    while (i < words.length) {
      var matched = 0;
      for (var len = Math.min(3, words.length - i); len >= 1; len--) {
        if (nameIndex[words.slice(i, i + len).join(' ')]) { matched = len; break; }
      }
      if (matched) { count++; i += matched; } else { i++; }
    }
    return count;
  }

  /**
   * The element to annotate: the smallest ancestor of the name that also holds
   * the card's opponent line, falling back to the nearest ancestor containing an
   * image, then to the name's parent.
   */
  function findCard(textNode) {
    var el = textNode.parentElement;
    if (!el) return null;

    var imgFallback = null;
    var cur = el;

    for (var i = 0; i < MAX_WALK_UP && cur && cur !== document.body; i++) {
      var text = cardText(cur);
      if (text !== null) {
        var norm = normalise(text);
        // Never annotate a container holding more than one player.
        if (nameMatchCount(norm) > 1) break;
        if (opponentTokens(norm).length) return widenToShirt(cur);
        if (!imgFallback && cur.querySelector && cur.querySelector('img')) imgFallback = cur;
      }
      cur = cur.parentElement;
    }

    return imgFallback || el.parentElement || el;
  }

  /**
   * Grow a card upwards until it also covers the player's shirt.
   *
   * The element holding the opponent line is FPL's name plate, which is pure
   * text — dropping a badge in its corner would sit on top of the player's name.
   * One or two levels up is the full card including the shirt, where the badge
   * has empty space to occupy. Stops as soon as a second player comes into
   * range, so a whole row is never treated as one card.
   */
  function widenToShirt(card) {
    if (card.querySelector && card.querySelector('img')) return card;

    var cur = card.parentElement;
    for (var i = 0; i < 2 && cur && cur !== document.body; i++) {
      var text = cardText(cur);
      if (text === null) break;
      if (nameMatchCount(normalise(text)) > 1) break;
      if (cur.querySelector && cur.querySelector('img')) return cur;
      cur = cur.parentElement;
    }
    return card;
  }

  /** Resolve a shared name down to one player using everything on the card. */
  function resolvePlayer(candidates, card) {
    if (candidates.length === 1) return candidates[0];

    var exact = photoPlayer(card);
    if (exact && candidates.indexOf(exact) !== -1) return exact;

    var norm = normalise(cardText(card) || '');

    // Strongest signal: the opponent printed on the card must be a fixture this
    // player's club actually has this gameweek.
    var cardTokens = opponentTokens(norm);
    if (cardTokens.length) {
      var byFixture = candidates.filter(function (p) {
        return tokensAgree(cardTokens, playerFixtureTokens(p));
      });
      if (byFixture.length === 1) return byFixture[0];
      if (byFixture.length) candidates = byFixture;
    }

    var codes = shirtTeamCodes(card);
    if (codes.length) {
      var byCode = candidates.filter(function (p) {
        var t = ctx.teamsById[p.team];
        return t && codes.indexOf(t.code) !== -1;
      });
      if (byCode.length === 1) return byCode[0];
      if (byCode.length) candidates = byCode;
    }

    var byShortName = candidates.filter(function (p) {
      var t = ctx.teamsById[p.team];
      return t && norm.indexOf(normalise(t.short_name)) !== -1;
    });
    if (byShortName.length === 1) return byShortName[0];
    if (byShortName.length) candidates = byShortName;

    // Still ambiguous: the most-owned player is the likeliest one on screen.
    return candidates.slice().sort(function (a, b) {
      return parseFloat(b.selected_by_percent) - parseFloat(a.selected_by_percent);
    })[0];
  }

  // ----------------------------------------------------------------- rendering

  function makeChip(chip) {
    var span = document.createElement('span');
    span.className = 'fplxp-chip' + (chip.blank ? ' fplxp-chip--blank' : '');
    span.textContent = chip.label;
    span.title = chip.title;
    if (!chip.blank) {
      var c = window.FPLXP.fdrColour(chip.difficulty);
      span.style.backgroundColor = c.bg;
      span.style.color = c.fg;
    }
    if (chip.double) span.classList.add('fplxp-chip--double');
    return span;
  }

  function xpClass(xp) {
    if (xp >= 6) return 'fplxp-badge--elite';
    if (xp >= 4) return 'fplxp-badge--good';
    if (xp >= 2) return 'fplxp-badge--ok';
    return 'fplxp-badge--low';
  }

  /**
   * Is there room above the player's name inside the card for the badge?
   *
   * Measured rather than inferred. Which element ends up being the card depends
   * on markup we do not control: sometimes it is the full card with the shirt on
   * top (plenty of room), sometimes just FPL's name plate (none at all, so a
   * corner badge lands on the name). Comparing the name's offset from the card's
   * top answers that directly, whatever the structure turns out to be.
   */
  function hasRoomAboveName(card, nameNode) {
    var nameEl = nameNode && nameNode.parentElement;
    if (!nameEl || !card.getBoundingClientRect) return null;

    var cardRect = card.getBoundingClientRect();
    var nameRect = nameEl.getBoundingClientRect();
    // Nothing is laid out yet (hidden tab, or a non-visual environment).
    if (!cardRect.height || !nameRect.height) return null;

    return (nameRect.top - cardRect.top) >= BADGE_CLEARANCE;
  }

  function annotate(card, player, nameNode) {
    var xp = window.FPLXP.playerXP(ctx, player);

    if (settings.showXp) {
      var badge = document.createElement('div');
      badge.className = 'fplxp-badge ' + xpClass(xp.xp);
      badge.textContent = 'xP ' + xp.xp.toFixed(1);

      var detail = [
        player.web_name + ' — GW' + xp.gw,
        'Model xP: ' + xp.modelXP.toFixed(2),
        isFinite(xp.fplEp) ? 'FPL estimate: ' + xp.fplEp.toFixed(1) : null,
        'Expected minutes: ' + Math.round(xp.xMins),
        xp.blank ? 'Blank gameweek' : null,
        xp.double ? 'Double gameweek' : null,
        xp.unavailable ? 'Flagged as unavailable' : null
      ].filter(Boolean);
      xp.fixtures.forEach(function (f) {
        detail.push('  vs ' + f.opponent + ' (' + (f.isHome ? 'H' : 'A') + ', FDR ' +
          f.difficulty + '): ' + f.points.toFixed(2));
      });
      badge.title = detail.join('\n');

      // Sit the badge above the card when the name starts at its top edge,
      // otherwise it covers the player's name. Falls back to looking for a
      // shirt image when nothing can be measured.
      var room = hasRoomAboveName(card, nameNode);
      if (room === null) room = !!(card.querySelector && card.querySelector('img'));
      if (!room) badge.classList.add('fplxp-badge--above');

      if (getComputedStyle(card).position === 'static') card.classList.add('fplxp-host');
      card.appendChild(badge);
    }

    if (settings.showFixtures) {
      var strip = document.createElement('div');
      strip.className = 'fplxp-strip';
      window.FPLXP.fixtureStrip(ctx, player.team, settings.fixtureCount)
        .forEach(function (chip) { strip.appendChild(makeChip(chip)); });
      card.appendChild(strip);
    }

    card.setAttribute(ANNOTATED, String(player.id));
  }

  // --------------------------------------------------------------------- scan

  function alreadyHandled(card) {
    if (card.hasAttribute(ANNOTATED)) return true;
    if (card.querySelector('[' + ANNOTATED + ']')) return true;
    return !!card.closest('[' + ANNOTATED + ']');
  }

  /**
   * Find a player name inside one short string.
   *
   * An exact match is trusted on its own. A partial match — a name plus extra
   * text such as "Raya £6.0m", or a run-together "RayaARS" — is reported as
   * inexact, and the caller then demands independent evidence that the container
   * really is a player card before acting on it. That keeps short UI labels which
   * happen to contain a surname ("Rice", "Wood") from being annotated.
   */
  /**
   * Is every word left over after removing the player's name something that
   * belongs on a player card?
   *
   * This is what separates "Haaland MCI" and "Raya £6.0m" from "Bernard King".
   * FPL first names include King, Kevin and Henry, so a league table full of
   * managers' real names would otherwise match players constantly. A club,
   * position, price or venue marker beside a name is expected; a second personal
   * name is not.
   */
  function leftoverIsBenign(tokens) {
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];
      if (!tok) continue;
      if (benignTokens[tok]) continue;
      if (/^\d/.test(tok)) continue;    // rank, price, "6m"
      if (tok.length === 1) continue;   // H/A venue, C/V armband, £ remnants
      return false;
    }
    return true;
  }

  function matchName(raw) {
    var norm = normalise(raw);
    if (!norm) return null;

    if (nameIndex[norm]) return { candidates: nameIndex[norm], exact: true };

    var words = norm.split(' ');
    // Longest window first, so "Alexander Arnold" beats "Arnold".
    for (var len = Math.min(3, words.length); len >= 1; len--) {
      for (var i = 0; i + len <= words.length; i++) {
        var key = words.slice(i, i + len).join(' ');
        if (!nameIndex[key]) continue;
        var rest = words.slice(0, i).concat(words.slice(i + len));
        if (!leftoverIsBenign(rest)) continue;
        return { candidates: nameIndex[key], exact: false };
      }
    }

    // Nothing separated the name from what follows it, e.g. "RayaARS".
    var compact = norm.replace(/ /g, '');
    for (var c = 0; c < compactNames.length; c++) {
      var cn = compactNames[c];
      var at = compact.indexOf(cn.compact);
      if (at === -1) continue;
      var remainder = (compact.slice(0, at) + compact.slice(at + cn.compact.length));
      if (remainder && !benignTokens[remainder] && !/^\d/.test(remainder)) continue;
      return { candidates: nameIndex[cn.key], exact: false };
    }
    return null;
  }

  /** Every text node that names a player. */
  function findNameNodes() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var v = node.nodeValue;
        if (!v) return NodeFilter.FILTER_REJECT;
        var t = v.trim();
        if (t.length < 2 || t.length > NAME_MAX_LEN) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    var hits = [];
    var node;
    while ((node = walker.nextNode())) {
      // Skip our own output.
      if (node.parentElement && /^fplxp-/.test(node.parentElement.className || '')) continue;
      var m = matchName(node.nodeValue);
      if (m) hits.push({ node: node, candidates: m.candidates, exact: m.exact });
    }
    return hits;
  }

  /** Does this container actually look like a player card? */
  function looksLikeCard(card) {
    var norm = normalise(cardText(card) || '');
    if (opponentTokens(norm).length) return true;
    if (shirtTeamCodes(card).length) return true;
    if (photoPlayer(card)) return true;
    return false;
  }

  function onPlayerPage() {
    var path = location.pathname;
    for (var i = 0; i < PLAYER_PAGES.length; i++) {
      if (PLAYER_PAGES[i].test(path)) return true;
    }
    return false;
  }

  function scan() {
    if (!ctx) return 0;
    debug.scans++;

    // A single-page app changes route without reloading, so this is checked on
    // every scan rather than once at startup.
    if (!onPlayerPage()) {
      debug.skippedPage = location.pathname;
      clearAnnotations();
      return 0;
    }
    debug.skippedPage = null;

    var hits = findNameNodes();
    debug.nameHits = hits.length;
    var count = 0;

    for (var i = 0; i < hits.length; i++) {
      var card = findCard(hits[i].node);
      if (!card || alreadyHandled(card)) { debug.cardsRejected++; continue; }

      // Every match needs corroboration that this really is a player card, an
      // exact one included: managers share names with players (Harry Kane, Chris
      // Wood), so an exact hit on a league table row is still the wrong thing to
      // annotate. A genuine card carries an opponent line, a shirt or a photo.
      if (!looksLikeCard(card)) { debug.cardsRejected++; continue; }

      try {
        annotate(card, resolvePlayer(hits[i].candidates, card), hits[i].node);
        count++;
      } catch (e) {
        debug.lastError = String(e);
        console.warn(TAG, 'failed to annotate', e);
      }
    }

    debug.annotated += count;
    return count;
  }

  function scheduleScan(delay) {
    clearTimeout(scheduled);
    scheduled = setTimeout(function () {
      var n = scan();
      if (n) console.log(TAG, 'annotated ' + n + ' player cards');
    }, delay === undefined ? 250 : delay);
  }

  function clearAnnotations() {
    document.querySelectorAll('.fplxp-badge, .fplxp-strip').forEach(function (el) {
      el.remove();
    });
    document.querySelectorAll('[' + ANNOTATED + ']').forEach(function (el) {
      el.removeAttribute(ANNOTATED);
    });
  }

  // -------------------------------------------------------------------- setup

  function loadSettings() {
    return new Promise(function (resolve) {
      chrome.storage.local.get({ settings: settings }, function (items) {
        settings = Object.assign(settings, items.settings || {});
        resolve();
      });
    });
  }

  function loadCore() {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage({ type: 'core' }, function (res) {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res || !res.ok) return reject(new Error((res && res.error) || 'no response'));
        resolve(res.data);
      });
    });
  }

  /**
   * Work out the user's own manager ID so the popup never has to ask for it.
   *
   * `/api/me/` returns the logged-in manager's entry id, but only when the
   * session cookie is sent — which is why this runs here in the page's origin
   * rather than in the service worker. Unauthenticated it answers 200 with
   * `{"player": null}`, so a logged-out visit simply finds nothing.
   */
  function detectManagerId() {
    var fromUrl = location.pathname.match(/\/entry\/(\d+)\b/);
    var urlId = fromUrl ? fromUrl[1] : null;

    // Guarded so a missing or throwing fetch cannot take the overlay down with
    // it — this is a convenience, never a prerequisite.
    var request;
    try {
      request = fetch('/api/me/', {
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' }
      });
    } catch (e) {
      request = Promise.reject(e);
    }

    return request
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        // Only `entry` is the team id — `player.id` is a different user id.
        var entry = data && data.player && data.player.entry;
        return entry ? String(entry) : urlId;
      })
      .catch(function () { return urlId; })
      .then(function (id) {
        if (!id) return;
        chrome.storage.local.get({ settings: {} }, function (items) {
          var s = items.settings || {};
          // Never clobber an ID the user typed in themselves — they may be
          // looking at someone else's team on purpose.
          if (s.detectedEntryId === id && s.entryId) return;
          s.detectedEntryId = id;
          if (!s.entryId) s.entryId = id;
          chrome.storage.local.set({ settings: s });
          console.log(TAG, 'manager ID detected: ' + id);
        });
      });
  }

  /** Exposed so problems can be diagnosed from the page console. */
  function installDebugHook() {
    window.__fplxp = {
      debug: debug,
      rescan: function () { clearAnnotations(); return scan(); },
      report: function () {
        var hits = ctx ? findNameNodes() : [];
        var sample = hits.slice(0, 5).map(function (h) {
          var card = findCard(h.node);
          return {
            name: h.node.nodeValue.trim(),
            candidates: h.candidates.length,
            cardTag: card ? card.tagName + '.' + (card.className || '').split(' ')[0] : null,
            cardText: card ? (card.textContent || '').slice(0, 60) : null,
            opponentTokens: card ? opponentTokens(normalise(cardText(card) || '')) : []
          };
        });
        return {
          ready: debug.ready,
          onPlayerPage: onPlayerPage(),
          path: location.pathname,
          targetGw: ctx && ctx.targetGw,
          nameNodesFound: hits.length,
          annotatedNow: document.querySelectorAll('[' + ANNOTATED + ']').length,
          settings: settings,
          debug: debug,
          sample: sample
        };
      }
    };
  }

  function start() {
    installDebugHook();

    // Independent of the overlay: the popup still benefits if this succeeds and
    // the page markup has changed underneath us. Failure here must never stop
    // the overlay from loading.
    try {
      detectManagerId();
    } catch (e) {
      console.warn(TAG, 'manager ID detection failed:', e);
    }

    Promise.all([loadSettings(), loadCore()]).then(function (r) {
      var data = r[1];
      ctx = window.FPLXP.buildContext(data.bootstrap, data.fixtures);
      buildIndexes(data.bootstrap);
      debug.ready = true;
      console.log(TAG, 'ready — target GW' + ctx.targetGw +
        ' (run __fplxp.report() to diagnose)');

      scheduleScan(0);

      // FPL re-renders constantly, so keep watching and re-scan on a debounce.
      var observer = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            // Ignore our own insertions or we loop forever.
            if (n.nodeType === 1 && !/^fplxp-/.test(n.className || '')) {
              scheduleScan();
              return;
            }
            if (n.nodeType === 3) { scheduleScan(); return; }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      window.addEventListener('popstate', function () { scheduleScan(400); });
    }).catch(function (err) {
      debug.lastError = err.message;
      console.warn(TAG, 'disabled:', err.message);
    });
  }

  chrome.storage.onChanged.addListener(function (changes) {
    if (!changes.settings) return;
    var next = changes.settings.newValue || {};
    // Only the display options warrant a redraw; writing a detected manager ID
    // must not make the whole page flicker.
    var redraw = ['showXp', 'showFixtures', 'fixtureCount'].some(function (k) {
      return next[k] !== settings[k];
    });
    settings = Object.assign(settings, next);
    if (!redraw) return;
    clearAnnotations();
    scheduleScan(0);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
