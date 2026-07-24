/*
 * Injects an xP badge and a 5-fixture strip onto every player card FPL renders.
 *
 * FPL is a React app with hashed styled-components class names, so we do not
 * rely on any single selector. Instead we anchor on the shirt/photo images that
 * every player card contains, walk up a few levels to find the card, and
 * identify the player from the text inside it. If the markup changes shape the
 * worst case is that nothing is annotated — the popup still works.
 */
(function () {
  'use strict';

  var TAG = '[FPL xP]';
  var ANNOTATED = 'data-fplxp';
  var MAX_WALK_UP = 6;

  var ctx = null;
  var nameIndex = null;   // normalised name -> [player, ...]
  var photoIndex = null;  // photo id -> player
  var compactNames = [];  // space-free name keys, longest first
  var settings = { showXp: true, showFixtures: true, fixtureCount: 5 };
  var scheduled = null;

  // ------------------------------------------------------------------ helpers

  function normalise(s) {
    return s
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
    compactNames = [];

    bootstrap.elements.forEach(function (p) {
      [p.web_name, p.second_name, p.first_name + ' ' + p.second_name].forEach(function (raw) {
        if (!raw) return;
        var key = normalise(raw);
        if (!key) return;
        if (!nameIndex[key]) nameIndex[key] = [];
        if (nameIndex[key].indexOf(p) === -1) nameIndex[key].push(p);
      });

      if (p.photo) {
        photoIndex[String(p.photo).replace(/\.\w+$/, '')] = p;
      }
    });

    // Space-free keys for the substring fallback, longest first so that
    // "alexanderarnold" is tried before "arnold".
    compactNames = Object.keys(nameIndex)
      .map(function (k) { return { compact: k.replace(/ /g, ''), key: k }; })
      .filter(function (e) { return e.compact.length >= 4; })
      .sort(function (a, b) { return b.compact.length - a.compact.length; });
  }

  /**
   * Text inside this element, capped so huge containers are skipped.
   *
   * `textContent` runs sibling elements together — FPL renders the name and the
   * team in separate divs, giving "SalahLIV" — so collect text nodes and join
   * them with spaces instead.
   */
  function cardText(el) {
    if ((el.textContent || '').length > 120) return null;

    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var parts = [];
    var node;
    while ((node = walker.nextNode())) {
      var t = (node.nodeValue || '').trim();
      if (t) parts.push(t);
    }
    if (!parts.length) return null;
    return parts.join(' ');
  }

  /**
   * Try to work out which player a candidate card is showing.
   *
   * Order of preference: the player photo id in an <img> (unambiguous), then a
   * name match narrowed by team code or team short name.
   */
  function identifyPlayer(el) {
    var imgs = el.querySelectorAll ? el.querySelectorAll('img') : [];
    var teamCode = null;

    for (var i = 0; i < imgs.length; i++) {
      var src = imgs[i].getAttribute('src') || '';
      var photo = src.match(/\/p(\d+)\.(?:png|jpg|webp)/);
      if (photo && photoIndex[photo[1]]) return photoIndex[photo[1]];
      var shirt = src.match(/shirt_(\d+)/);
      if (shirt) teamCode = parseInt(shirt[1], 10);
    }

    var text = cardText(el);
    if (!text) return null;

    var norm = normalise(text);
    if (!norm) return null;

    var words = norm.split(' ');
    var candidates = null;

    // Longest match first so "Alexander Arnold" beats "Alexander".
    for (var len = Math.min(3, words.length); len >= 1 && !candidates; len--) {
      for (var start = 0; start + len <= words.length; start++) {
        var key = words.slice(start, start + len).join(' ');
        if (nameIndex[key]) { candidates = nameIndex[key]; break; }
      }
    }

    // Fallback for markup that leaves no word boundary at all.
    if (!candidates) {
      var compact = norm.replace(/ /g, '');
      for (var c = 0; c < compactNames.length; c++) {
        if (compact.indexOf(compactNames[c].compact) !== -1) {
          candidates = nameIndex[compactNames[c].key];
          break;
        }
      }
    }

    if (!candidates || !candidates.length) return null;
    if (candidates.length === 1) return candidates[0];

    // Ambiguous surname — narrow by the club shown on the same card.
    var narrowed = candidates;
    if (teamCode !== null) {
      narrowed = candidates.filter(function (p) {
        var t = ctx.teamsById[p.team];
        return t && t.code === teamCode;
      });
      if (narrowed.length === 1) return narrowed[0];
      if (!narrowed.length) narrowed = candidates;
    }

    var byShortName = narrowed.filter(function (p) {
      var t = ctx.teamsById[p.team];
      return t && norm.indexOf(normalise(t.short_name)) !== -1;
    });
    if (byShortName.length === 1) return byShortName[0];

    // Still ambiguous: pick the most-selected player, which is the most likely
    // one to be on screen, rather than annotating the wrong man silently.
    return narrowed.slice().sort(function (a, b) {
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

  function annotate(card, player) {
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

      // The card is positioned so the badge can sit in its corner.
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

  /**
   * Walk up from each shirt/photo image until we hit an element we can identify
   * as a player card, then annotate it once.
   */
  function scan() {
    if (!ctx) return 0;

    // Anchor on shirt and player-photo images — the one thing every player card
    // has. Kept reasonably narrow so big pages are not walked needlessly.
    var imgs = document.querySelectorAll(
      'img[src*="shirt"], img[src*="photos/players"], img[src*="/players/"]'
    );
    var count = 0;

    for (var i = 0; i < imgs.length; i++) {
      var node = imgs[i].parentElement;
      for (var up = 0; up < MAX_WALK_UP && node; up++, node = node.parentElement) {
        if (node.hasAttribute(ANNOTATED)) break;
        if (node.querySelector('[' + ANNOTATED + ']')) break; // already inside
        var player = identifyPlayer(node);
        if (player) {
          try {
            annotate(node, player);
            count++;
          } catch (e) {
            console.warn(TAG, 'failed to annotate', player && player.web_name, e);
          }
          break;
        }
      }
    }
    return count;
  }

  function scheduleScan(delay) {
    clearTimeout(scheduled);
    scheduled = setTimeout(function () {
      var n = scan();
      if (n) console.debug(TAG, 'annotated', n, 'player cards');
    }, delay || 250);
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
        if (!res || !res.ok) return reject(new Error(res && res.error || 'no response'));
        resolve(res.data);
      });
    });
  }

  function start() {
    Promise.all([loadSettings(), loadCore()]).then(function (r) {
      var data = r[1];
      ctx = window.FPLXP.buildContext(data.bootstrap, data.fixtures);
      buildIndexes(data.bootstrap);
      console.debug(TAG, 'ready — target GW' + ctx.targetGw);

      scheduleScan(0);

      // FPL re-renders constantly (drag/drop, tab switches, dialogs), so keep
      // watching and re-scan on a debounce.
      var observer = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          // Ignore our own insertions or we loop forever.
          var added = records[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType === 1 && !/^fplxp-/.test(n.className || '')) {
              scheduleScan();
              return;
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // Client-side navigation does not fire load events.
      window.addEventListener('popstate', function () { scheduleScan(400); });
    }).catch(function (err) {
      console.warn(TAG, 'disabled:', err.message);
    });
  }

  chrome.storage.onChanged.addListener(function (changes) {
    if (!changes.settings) return;
    settings = Object.assign(settings, changes.settings.newValue || {});
    document.querySelectorAll('.fplxp-badge, .fplxp-strip').forEach(function (el) { el.remove(); });
    document.querySelectorAll('[' + ANNOTATED + ']').forEach(function (el) {
      el.removeAttribute(ANNOTATED);
    });
    scheduleScan(0);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
