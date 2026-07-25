/*
 * Popup UI. Works regardless of what FPL does to its own markup, so this is the
 * reliable half of the extension: enter a manager ID once and get the squad with
 * xP and the next five fixtures, plus a league-wide xP leaderboard.
 */
(function () {
  'use strict';

  var DEFAULT_SETTINGS = {
    showXp: true,
    showFixtures: true,
    // Player lists are much denser than the pitch, so they toggle separately.
    showXpList: true,
    showFixturesList: true,
    fixtureCount: 5,
    entryId: '',
    // Filled in by the content script from /api/me/ when you visit FPL logged in.
    detectedEntryId: ''
  };

  var ctx = null;
  var bootstrap = null;
  var elementsById = {};
  var settings = Object.assign({}, DEFAULT_SETTINGS);
  var topSort = { key: 'xp', dir: -1 };

  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------- messaging

  function send(msg) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(msg, function (res) {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res || !res.ok) return reject(new Error((res && res.error) || 'No response'));
        resolve(res.data);
      });
    });
  }

  function showError(msg) {
    var box = $('error');
    box.textContent = msg;
    box.classList.remove('error--hidden');
  }

  function clearError() {
    $('error').classList.add('error--hidden');
  }

  // ------------------------------------------------------------- formatting

  function money(now_cost) {
    return '£' + (now_cost / 10).toFixed(1) + 'm';
  }

  function xpCell(xp) {
    var cls = xp >= 6 ? 'xp--elite' : (xp >= 4 ? 'xp--good' : (xp < 2 ? 'xp--low' : ''));
    var td = document.createElement('td');
    td.className = 'num xp ' + cls;
    td.textContent = xp.toFixed(1);
    return td;
  }

  function stripCell(teamId) {
    var td = document.createElement('td');
    var wrap = document.createElement('div');
    wrap.className = 'strip';
    window.FPLXP.fixtureStrip(ctx, teamId, settings.fixtureCount).forEach(function (chip) {
      var span = document.createElement('span');
      span.className = 'chip' + (chip.blank ? ' chip--blank' : '') + (chip.double ? ' chip--double' : '');
      span.textContent = chip.label;
      span.title = chip.title;
      if (!chip.blank) {
        var c = window.FPLXP.fdrColour(chip.difficulty);
        span.style.backgroundColor = c.bg;
        span.style.color = c.fg;
      }
      wrap.appendChild(span);
    });
    td.appendChild(wrap);
    return td;
  }

  function nameCell(player, extra) {
    var td = document.createElement('td');
    td.className = 'name';
    td.appendChild(document.createTextNode(player.web_name));

    if (extra && extra.armband) {
      var band = document.createElement('span');
      band.className = 'armband';
      band.textContent = extra.armband;
      td.appendChild(band);
    }

    // Injury / availability flag, using FPL's own news text as the tooltip.
    if (player.status !== 'a') {
      var flag = document.createElement('span');
      flag.className = 'name__flag';
      flag.textContent = ' ●';
      var chance = player.chance_of_playing_next_round;
      flag.title = (player.news || 'Doubtful') +
        (chance === null || chance === undefined ? '' : ' (' + chance + '% chance)');
      td.appendChild(flag);
    }

    var team = ctx.teamsById[player.team];
    var sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = (team ? team.short_name : '?') + ' · ' +
      window.FPLXP.positionShort(ctx, player.element_type) + ' · ' + money(player.now_cost);
    td.appendChild(sub);

    return td;
  }

  function tooltipFor(player, xp) {
    var lines = [
      'Model xP: ' + xp.modelXP.toFixed(2),
      isFinite(xp.fplEp) ? 'FPL estimate: ' + xp.fplEp.toFixed(1) : null,
      'Expected minutes: ' + Math.round(xp.xMins),
      'Form: ' + player.form + ' · PPG: ' + player.points_per_game,
      xp.blank ? 'Blank gameweek' : null,
      xp.double ? 'Double gameweek' : null
    ].filter(Boolean);
    xp.fixtures.forEach(function (f) {
      lines.push('vs ' + f.opponent + ' (' + (f.isHome ? 'H' : 'A') + ', FDR ' + f.difficulty +
        '): ' + f.points.toFixed(2));
    });
    return lines.join('\n');
  }

  // ----------------------------------------------------------------- squad

  function renderSquad(data) {
    var body = $('squad-body');
    body.textContent = '';

    var entry = data.entry || {};
    $('squad-meta').textContent = [
      entry.name ? entry.name : null,
      entry.player_first_name ? entry.player_first_name + ' ' + entry.player_last_name : null,
      entry.summary_overall_rank ? 'OR ' + entry.summary_overall_rank.toLocaleString() : null,
      data.pickedGw ? 'squad as of GW' + data.pickedGw : null
    ].filter(Boolean).join(' · ');

    if (!data.picks || !data.picks.picks) {
      // FPL keeps squads private until a gameweek kicks off, so there is nothing
      // to read before GW1 or for a manager who sat that gameweek out.
      var reason = data.pickedGw
        ? 'FPL has no public squad for this manager in GW' + data.pickedGw + '.'
        : 'Squads are only public once a gameweek has kicked off, so nothing is ' +
          'available until GW1 starts.';
      body.innerHTML = '<p class="empty">' + reason +
        '<br><br>The <b>Top xP</b> tab works right now.</p>';
      return;
    }

    var rows = data.picks.picks.map(function (pick) {
      var player = elementsById[pick.element];
      if (!player) return null;
      var xp = window.FPLXP.playerXP(ctx, player);
      return {
        pick: pick,
        player: player,
        xp: xp,
        // multiplier is 0 on the bench, 1 on the pitch, 2/3 for (triple) captain
        benched: pick.position > 11
      };
    }).filter(Boolean);

    var table = document.createElement('table');
    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Player</th><th class="num">xP</th><th>Next ' +
      settings.fixtureCount + '</th></tr>';
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var starters = rows.filter(function (r) { return !r.benched; });
    var bench = rows.filter(function (r) { return r.benched; });

    function addGroup(label, list, benched) {
      if (!list.length) return;
      var gr = document.createElement('tr');
      gr.className = 'group-row';
      var xpTotal = list.reduce(function (a, r) {
        var mult = benched ? 1 : Math.max(1, r.pick.multiplier);
        return a + r.xp.xp * mult;
      }, 0);
      gr.innerHTML = '<td colspan="3">' + label + ' — ' + xpTotal.toFixed(1) + ' xP</td>';
      tbody.appendChild(gr);

      list.forEach(function (r) {
        var tr = document.createElement('tr');
        if (benched) tr.className = 'bench';
        var armband = r.pick.is_captain ? 'C' : (r.pick.is_vice_captain ? 'V' : null);
        tr.appendChild(nameCell(r.player, { armband: armband }));

        var effective = r.xp.xp * (benched ? 1 : Math.max(1, r.pick.multiplier));
        var cell = xpCell(effective);
        cell.title = tooltipFor(r.player, r.xp) +
          (r.pick.multiplier > 1 ? '\nCaptain multiplier ×' + r.pick.multiplier : '');
        tr.appendChild(cell);

        tr.appendChild(stripCell(r.player.team));
        tbody.appendChild(tr);
      });
    }

    addGroup('Starting XI', starters, false);
    addGroup('Bench', bench, true);

    table.appendChild(tbody);
    body.appendChild(table);
  }

  function loadSquad(entryId) {
    if (!/^\d+$/.test(String(entryId || '').trim())) {
      showError('Enter a numeric manager ID.');
      return;
    }
    clearError();
    $('squad-body').innerHTML = '<p class="loading">Loading squad…</p>';

    // Picks are only public once a gameweek has kicked off, so read the most
    // recent started gameweek rather than the one being picked for. Null in the
    // off-season — still worth fetching the entry to validate the ID.
    var pickedGw = window.FPLXP.latestStartedGameweek(bootstrap.events);

    send({ type: 'squad', entryId: entryId, gw: pickedGw }).then(function (data) {
      data.pickedGw = pickedGw;
      renderSquad(data);
      settings.entryId = String(entryId).trim();
      chrome.storage.local.set({ settings: settings });
    }).catch(function (err) {
      $('squad-body').textContent = '';
      showError('Could not load that squad: ' + err.message);
    });
  }

  // --------------------------------------------------------------- top xP

  function renderTop() {
    var pos = parseInt($('top-pos').value, 10);
    var maxCost = parseInt($('top-price').value, 10) * 10;

    var rows = bootstrap.elements
      .filter(function (p) {
        if (pos && p.element_type !== pos) return false;
        if (p.now_cost > maxCost) return false;
        // Hide players who cannot play at all; keep doubtful ones visible.
        return p.status !== 'u' && p.status !== 'n';
      })
      .map(function (p) { return { player: p, xp: window.FPLXP.playerXP(ctx, p) }; });

    rows.sort(function (a, b) {
      var av, bv;
      if (topSort.key === 'value') {
        av = a.xp.xp / (a.player.now_cost / 10);
        bv = b.xp.xp / (b.player.now_cost / 10);
      } else if (topSort.key === 'cost') {
        av = a.player.now_cost; bv = b.player.now_cost;
      } else {
        av = a.xp.xp; bv = b.xp.xp;
      }
      return (av - bv) * topSort.dir;
    });

    rows = rows.slice(0, 40);

    var body = $('top-body');
    body.textContent = '';

    if (!rows.length) {
      body.innerHTML = '<p class="empty">No players match those filters.</p>';
      return;
    }

    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    [
      { label: 'Player', key: null },
      { label: 'xP', key: 'xp', num: true },
      { label: 'xP/£m', key: 'value', num: true },
      { label: 'Next ' + settings.fixtureCount, key: null }
    ].forEach(function (col) {
      var th = document.createElement('th');
      th.textContent = col.label + (topSort.key === col.key ? (topSort.dir < 0 ? ' ▾' : ' ▴') : '');
      if (col.num) th.className = 'num';
      if (col.key) {
        th.addEventListener('click', function () {
          if (topSort.key === col.key) topSort.dir *= -1;
          else { topSort.key = col.key; topSort.dir = -1; }
          renderTop();
        });
      } else {
        th.style.cursor = 'default';
      }
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.appendChild(nameCell(r.player));

      var cell = xpCell(r.xp.xp);
      cell.title = tooltipFor(r.player, r.xp);
      tr.appendChild(cell);

      var val = document.createElement('td');
      val.className = 'num';
      val.textContent = (r.xp.xp / (r.player.now_cost / 10)).toFixed(2);
      tr.appendChild(val);

      tr.appendChild(stripCell(r.player.team));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);
  }

  // -------------------------------------------------------------- settings

  function bindSettings() {
    $('opt-xp').checked = settings.showXp;
    $('opt-fix').checked = settings.showFixtures;
    $('opt-xp-list').checked = settings.showXpList;
    $('opt-fix-list').checked = settings.showFixturesList;
    $('opt-count').value = settings.fixtureCount;

    function persist() {
      settings.showXp = $('opt-xp').checked;
      settings.showFixtures = $('opt-fix').checked;
      settings.showXpList = $('opt-xp-list').checked;
      settings.showFixturesList = $('opt-fix-list').checked;
      var n = parseInt($('opt-count').value, 10);
      settings.fixtureCount = isFinite(n) ? Math.min(8, Math.max(1, n)) : 5;
      $('opt-count').value = settings.fixtureCount;
      chrome.storage.local.set({ settings: settings });
      if (ctx) { renderTop(); }
    }

    ['opt-xp', 'opt-fix', 'opt-xp-list', 'opt-fix-list', 'opt-count'].forEach(function (id) {
      $(id).addEventListener('change', persist);
    });

    $('refresh').addEventListener('click', function () {
      $('settings-note').textContent = 'Refreshing…';
      send({ type: 'core', fresh: true }).then(function (data) {
        applyCore(data);
        $('settings-note').textContent = 'Data refreshed just now.';
        renderTop();
        if (settings.entryId) loadSquad(settings.entryId);
      }).catch(function (err) {
        $('settings-note').textContent = 'Refresh failed: ' + err.message;
      });
    });
  }

  function bindTabs() {
    var tabs = document.querySelectorAll('.tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) { t.classList.remove('tab--active'); });
        tab.classList.add('tab--active');
        ['squad', 'top', 'settings'].forEach(function (view) {
          $('view-' + view).classList.toggle('view--hidden', view !== tab.dataset.view);
        });
      });
    });
  }

  // ------------------------------------------------------------------ boot

  function applyCore(data) {
    bootstrap = data.bootstrap;
    ctx = window.FPLXP.buildContext(data.bootstrap, data.fixtures);
    elementsById = {};
    bootstrap.elements.forEach(function (p) { elementsById[p.id] = p; });

    var event = bootstrap.events.find(function (e) { return e.id === ctx.targetGw; });
    var label = 'GW' + ctx.targetGw;
    if (event && event.deadline_time) {
      var deadline = new Date(event.deadline_time);
      var live = event.is_current && !event.finished;
      label += live ? ' · live' : ' · deadline ' + deadline.toLocaleString(undefined, {
        weekday: 'short', hour: '2-digit', minute: '2-digit'
      });
    }
    $('gw').textContent = label;
  }

  function init() {
    bindTabs();

    chrome.storage.local.get({ settings: DEFAULT_SETTINGS }, function (items) {
      settings = Object.assign({}, DEFAULT_SETTINGS, items.settings || {});
      bindSettings();

      // Prefer an ID the user typed; otherwise use the one detected from their
      // logged-in session, so the common case needs no input at all.
      var activeId = settings.entryId || settings.detectedEntryId || '';
      $('entry-id').value = activeId;
      if (!settings.entryId && settings.detectedEntryId) {
        $('entry-hint').textContent =
          'Detected from your signed-in FPL session — nothing to enter.';
      }

      $('entry-form').addEventListener('submit', function (e) {
        e.preventDefault();
        loadSquad($('entry-id').value);
      });
      $('top-pos').addEventListener('change', renderTop);
      $('top-price').addEventListener('change', renderTop);

      $('squad-body').innerHTML = '<p class="loading">Loading FPL data…</p>';

      send({ type: 'core' }).then(function (data) {
        applyCore(data);
        renderTop();
        if (activeId) {
          loadSquad(activeId);
        } else {
          $('squad-body').innerHTML = '<p class="empty">Visit ' +
            'fantasy.premierleague.com while signed in and your manager ID is ' +
            'picked up automatically — or enter it above.</p>';
        }
      }).catch(function (err) {
        $('squad-body').textContent = '';
        showError('Could not reach the FPL API: ' + err.message);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
