/*
 * Service worker: the single place that talks to the FPL API.
 *
 * Both the content script and the popup ask for data through messages so that
 * one cache is shared and we never hammer the API from several tabs at once.
 */
'use strict';

var BASE = 'https://fantasy.premierleague.com/api/';

// bootstrap-static is ~1.5MB, so cache it hard. Prices and injury flags move
// a few times a day, which 15 minutes tracks closely enough.
var TTL = {
  'bootstrap-static/': 15 * 60 * 1000,
  'fixtures/': 60 * 60 * 1000,
  _default: 5 * 60 * 1000
};

var inFlight = {};

function cacheKey(path) {
  return 'cache:' + path;
}

function ttlFor(path) {
  return TTL[path] || TTL._default;
}

function readCache(path) {
  return new Promise(function (resolve) {
    var key = cacheKey(path);
    chrome.storage.local.get(key, function (items) {
      var hit = items && items[key];
      if (hit && Date.now() - hit.at < ttlFor(path)) resolve(hit.data);
      else resolve(null);
    });
  });
}

function writeCache(path, data) {
  var payload = {};
  payload[cacheKey(path)] = { at: Date.now(), data: data };
  // Best-effort: a quota failure must not break the response we already have.
  try {
    chrome.storage.local.set(payload);
  } catch (e) {
    console.warn('[FPL xP] cache write failed', e);
  }
}

function fetchPath(path, opts) {
  opts = opts || {};
  if (!opts.fresh) {
    if (inFlight[path]) return inFlight[path];
  }

  var promise = (opts.fresh ? Promise.resolve(null) : readCache(path))
    .then(function (cached) {
      if (cached) return cached;
      return fetch(BASE + path, {
        headers: { 'Accept': 'application/json' },
        credentials: 'omit'
      }).then(function (res) {
        if (!res.ok) throw new Error('FPL API ' + res.status + ' for ' + path);
        return res.json();
      }).then(function (data) {
        writeCache(path, data);
        return data;
      });
    })
    .then(function (data) {
      delete inFlight[path];
      return data;
    })
    .catch(function (err) {
      delete inFlight[path];
      throw err;
    });

  inFlight[path] = promise;
  return promise;
}

/** bootstrap-static + fixtures, the pair every view needs. */
function coreData(opts) {
  return Promise.all([
    fetchPath('bootstrap-static/', opts),
    fetchPath('fixtures/', opts)
  ]).then(function (r) {
    return { bootstrap: r[0], fixtures: r[1] };
  });
}

/**
 * A manager's squad. The authenticated my-team endpoint needs cookies we do not
 * have, so read the public per-gameweek picks for the most recent gameweek that
 * has kicked off — that is the squad the manager currently owns, give or take
 * transfers made since.
 */
function managerSquad(entryId, gw) {
  // Outside the season there is no started gameweek to read picks from.
  if (!gw) return Promise.resolve(null);
  var path = 'entry/' + encodeURIComponent(entryId) + '/event/' + gw + '/picks/';
  return fetchPath(path).catch(function (err) {
    // Picks stay private until the gameweek kicks off, and a manager who has
    // not played that gameweek has none at all. Both surface as 404/403.
    if (/40[34]/.test(err.message)) return null;
    throw err;
  });
}

function managerEntry(entryId) {
  return fetchPath('entry/' + encodeURIComponent(entryId) + '/');
}

var HANDLERS = {
  core: function (msg) {
    return coreData({ fresh: !!msg.fresh });
  },
  squad: function (msg) {
    return Promise.all([
      managerEntry(msg.entryId),
      managerSquad(msg.entryId, msg.gw)
    ]).then(function (r) {
      return { entry: r[0], picks: r[1] };
    });
  },
  clearCache: function () {
    return new Promise(function (resolve) {
      chrome.storage.local.get(null, function (items) {
        var keys = Object.keys(items || {}).filter(function (k) {
          return k.indexOf('cache:') === 0;
        });
        chrome.storage.local.remove(keys, function () { resolve({ cleared: keys.length }); });
      });
    });
  }
};

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  var handler = msg && HANDLERS[msg.type];
  if (!handler) return false;

  handler(msg).then(function (data) {
    sendResponse({ ok: true, data: data });
  }).catch(function (err) {
    console.error('[FPL xP]', msg.type, err);
    sendResponse({ ok: false, error: String(err && err.message || err) });
  });

  return true; // keep the message channel open for the async response
});
