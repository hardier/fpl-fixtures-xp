/*
 * FPL expected-points model + fixture helpers.
 *
 * Loaded as a classic script in both the content script and the popup, so it
 * exposes everything on a single global: window.FPLXP.
 *
 * The FPL API does not publish a real xP number. `element.ep_this` exists but is
 * close to a rolling points-per-game, so we build our own model from the
 * per-90 rates in bootstrap-static and blend towards ep_this only while a
 * player has too few minutes for their own rates to mean anything.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- constants

  var GK = 1, DEF = 2, MID = 3, FWD = 4;

  var GOAL_PTS = { 1: 6, 2: 6, 3: 5, 4: 4 };
  var CS_PTS = { 1: 4, 2: 4, 3: 1, 4: 0 };
  var ASSIST_PTS = 3;

  // Defensive-contribution thresholds (2025/26 rules). Defenders count
  // clearances + blocks + interceptions + tackles; everyone else adds recoveries.
  var DEFCON_THRESHOLD = { 1: Infinity, 2: 10, 3: 12, 4: 12 };
  var DEFCON_PTS = 2;

  // League-average goals per team per game, split by venue.
  var BASE_GOALS_HOME = 1.55;
  var BASE_GOALS_AWAY = 1.25;
  var BASE_GOALS_NEUTRAL = (BASE_GOALS_HOME + BASE_GOALS_AWAY) / 2;

  // Minutes of data before we trust a player's own per-90 rates completely.
  var MINUTES_FOR_FULL_TRUST = 450;

  // Fallback scaling by FDR, used when FPL has not populated its numeric team
  // strength ratings (they sit at 0 all through the off-season).
  // Attack: how much easier than an average (FDR 3) fixture this is.
  var FDR_ATTACK_MULT = { 1: 1.35, 2: 1.18, 3: 1.0, 4: 0.85, 5: 0.72 };
  // Defence: expected goals conceded against this level of opponent.
  var FDR_GOALS_CONCEDED = { 1: 0.75, 2: 0.95, 3: 1.3, 4: 1.7, 5: 2.1 };

  // FDR palette, matching the colours FPL itself uses on its fixture pages.
  var FDR_COLOURS = {
    1: { bg: '#375523', fg: '#ffffff' },
    2: { bg: '#01fc7a', fg: '#0e0e0e' },
    3: { bg: '#e7e7e7', fg: '#0e0e0e' },
    4: { bg: '#ff1751', fg: '#ffffff' },
    5: { bg: '#80072d', fg: '#ffffff' }
  };

  // ------------------------------------------------------------------- maths

  function clamp(x, lo, hi) {
    return x < lo ? lo : (x > hi ? hi : x);
  }

  function num(v, fallback) {
    var n = parseFloat(v);
    // Explicit undefined check so a NaN fallback survives (NaN is falsy).
    return isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }

  function poissonPmf(k, lambda) {
    if (lambda <= 0) return k === 0 ? 1 : 0;
    var logp = -lambda + k * Math.log(lambda);
    for (var i = 2; i <= k; i++) logp -= Math.log(i);
    return Math.exp(logp);
  }

  /** P(X >= k) for X ~ Poisson(lambda). */
  function poissonTail(k, lambda) {
    if (k <= 0) return 1;
    var below = 0;
    for (var i = 0; i < k; i++) below += poissonPmf(i, lambda);
    return clamp(1 - below, 0, 1);
  }

  /** E[floor(X / 2)] for X ~ Poisson(lambda) — the goals-conceded penalty. */
  function expectedConcededPenaltyUnits(lambda) {
    var total = 0;
    for (var k = 2; k <= 10; k++) total += Math.floor(k / 2) * poissonPmf(k, lambda);
    return total;
  }

  // ------------------------------------------------------- league-wide scaling

  /**
   * Mean attack/defence strength across the league, used to turn FPL's
   * per-team strength ratings into goal expectations.
   *
   * FPL leaves every `strength_attack_*` / `strength_defence_*` field at 0 until
   * a season is under way, so report whether the ratings are usable at all. When
   * they are not we fall back to the per-fixture FDR values, which are always
   * published.
   */
  function leagueAverages(teams) {
    var att = 0, def = 0, n = 0;
    teams.forEach(function (t) {
      var a = (num(t.strength_attack_home) + num(t.strength_attack_away)) / 2;
      var d = (num(t.strength_defence_home) + num(t.strength_defence_away)) / 2;
      if (a > 0 && d > 0) { att += a; def += d; n++; }
    });
    // Require most of the league before trusting the ratings.
    if (n < teams.length * 0.75 || !n) {
      return { attack: 0, defence: 0, usable: false };
    }
    return { attack: att / n, defence: def / n, usable: true };
  }

  function fdrLookup(table, difficulty) {
    var d = Math.round(num(difficulty, 3));
    return table[d] !== undefined ? table[d] : table[3];
  }

  /**
   * Goals for / against expectations for one team in one fixture.
   *
   * Higher `strength_defence_*` means a better defence, so it divides.
   */
  function fixtureGoalExpectation(team, opponent, isHome, avg, difficulty) {
    var forBase = isHome ? BASE_GOALS_HOME : BASE_GOALS_AWAY;
    var againstBase = isHome ? BASE_GOALS_AWAY : BASE_GOALS_HOME;
    var xG, xGC;

    if (avg.usable) {
      var ownAtt = isHome ? team.strength_attack_home : team.strength_attack_away;
      var ownDef = isHome ? team.strength_defence_home : team.strength_defence_away;
      var oppAtt = isHome ? opponent.strength_attack_away : opponent.strength_attack_home;
      var oppDef = isHome ? opponent.strength_defence_away : opponent.strength_defence_home;

      xG = forBase * clamp(ownAtt / avg.attack, 0.5, 2) * clamp(avg.defence / oppDef, 0.45, 2.2);
      xGC = againstBase * clamp(oppAtt / avg.attack, 0.5, 2) * clamp(avg.defence / ownDef, 0.45, 2.2);
    } else {
      // FDR is this team's own view of the fixture, so it already folds in both
      // clubs' quality and home advantage.
      xG = forBase * fdrLookup(FDR_ATTACK_MULT, difficulty);
      xGC = fdrLookup(FDR_GOALS_CONCEDED, difficulty) *
        (againstBase / BASE_GOALS_NEUTRAL);
    }

    return { xG: clamp(xG, 0.2, 4.5), xGC: clamp(xGC, 0.2, 4.5) };
  }

  /**
   * How much easier/harder this fixture is than the average fixture that is
   * already baked into a player's season-long per-90 rates.
   *
   * A player's xG90 reflects their average opposition, so we only need the
   * *relative* change: venue effect plus opponent defensive quality.
   */
  function attackMultiplier(opponent, isHome, avg, difficulty) {
    var venue = (isHome ? BASE_GOALS_HOME : BASE_GOALS_AWAY) / BASE_GOALS_NEUTRAL;
    if (!avg.usable) {
      // FDR already accounts for venue, so do not apply it twice.
      return clamp(fdrLookup(FDR_ATTACK_MULT, difficulty), 0.5, 1.8);
    }
    var oppDef = isHome ? opponent.strength_defence_away : opponent.strength_defence_home;
    return clamp(venue * clamp(avg.defence / oppDef, 0.45, 2.2), 0.5, 1.8);
  }

  // ------------------------------------------------------------------ minutes

  /**
   * Expected minutes for a single fixture, and the probability of reaching the
   * 60-minute mark that most bonus categories depend on.
   */
  function minutesModel(player, gamesPlayedByTeam) {
    var availability = player.chance_of_playing_next_round;
    availability = (availability === null || availability === undefined) ? 100 : availability;
    availability = clamp(availability / 100, 0, 1);

    // 'u' = unavailable / left the club, 'n' = not in squad, 's' = suspended.
    // Availability is about FPL's own flags only — never about how much history a
    // player has, or a new signing with no minutes would look ruled out.
    var blocked = player.status === 'u' || player.status === 'n' ||
      player.status === 's' || availability === 0;
    if (blocked) {
      return { xMins: 0, pStart: 0, p60: 0, pAppear: 0, available: false };
    }

    var games = Math.max(1, gamesPlayedByTeam || 1);
    var minutes = num(player.minutes);
    var starts = num(player.starts);

    // Average minutes per team game so far — players who miss games are
    // correctly penalised rather than being judged on appearances alone.
    var avgMins = clamp(minutes / games, 0, 90);
    var startRate = clamp(starts / games, 0, 1);

    // Blend the two signals: minutes capture cameos, start rate captures role.
    var xMins = clamp(0.65 * avgMins + 0.35 * (startRate * 82), 0, 90) * availability;

    var pStart = startRate * availability;
    // Starters usually see 60 minutes; substitutes rarely do.
    var p60 = clamp(pStart * 0.86 + clamp((xMins - pStart * 82) / 90, 0, 1) * 0.1, 0, 1);
    var pAppear = clamp(pStart + (1 - pStart) * clamp(avgMins / 30, 0, 0.75), 0, 1);

    return { xMins: xMins, pStart: pStart, p60: p60, pAppear: pAppear, available: true };
  }

  // --------------------------------------------------------------- rate model

  function per90(total, minutes, fallback) {
    if (minutes < 90) return fallback || 0;
    return (total * 90) / minutes;
  }

  /**
   * Expected points for one player in one fixture.
   */
  function fixtureXP(player, team, opponent, isHome, mins, avg, difficulty) {
    var pos = player.element_type;
    var minutes = num(player.minutes);
    var share = mins.xMins / 90;

    var goals = fixtureGoalExpectation(team, opponent, isHome, avg, difficulty);
    var attMult = attackMultiplier(opponent, isHome, avg, difficulty);

    // --- appearance points
    var p1to59 = clamp(mins.pAppear - mins.p60, 0, 1);
    var pts = mins.p60 * 2 + p1to59 * 1;

    // --- goals & assists. Prefer the underlying-stat per-90 rates, fall back
    //     to actual output when the xG fields are missing or empty.
    var xg90 = num(player.expected_goals_per_90, per90(num(player.goals_scored), minutes));
    var xa90 = num(player.expected_assists_per_90, per90(num(player.assists), minutes));

    var xGoals = xg90 * share * attMult;
    var xAssists = xa90 * share * attMult;

    pts += xGoals * GOAL_PTS[pos];
    pts += xAssists * ASSIST_PTS;

    // --- clean sheets: only awarded at 60+ minutes.
    if (CS_PTS[pos] > 0) {
      var pCleanSheet = Math.exp(-goals.xGC);
      pts += pCleanSheet * mins.p60 * CS_PTS[pos];
    }

    // --- goals conceded: -1 per 2 conceded, GK and DEF only.
    if (pos === GK || pos === DEF) {
      pts -= expectedConcededPenaltyUnits(goals.xGC) * mins.p60;
    }

    // --- saves: 1 point per 3, scaled by how much work the defence gives up.
    if (pos === GK) {
      var saves90 = per90(num(player.saves), minutes, 2.6);
      var workload = clamp(goals.xGC / BASE_GOALS_NEUTRAL, 0.5, 2);
      pts += (saves90 * share * workload) / 3;
      pts += per90(num(player.penalties_saved), minutes) * share * 5;
    }

    // --- defensive contributions (2025/26). Field may be absent on older data.
    var defconRate = player.defensive_contribution_per_90;
    if (defconRate === undefined || defconRate === null) {
      defconRate = per90(num(player.defensive_contribution), minutes);
    }
    defconRate = num(defconRate);
    var threshold = DEFCON_THRESHOLD[pos];
    if (defconRate > 0 && threshold !== Infinity) {
      // Defensive work scales with time on the pitch and with being under
      // pressure, so nudge it by the opponent's expected goals.
      var lambda = defconRate * share * clamp(goals.xGC / BASE_GOALS_NEUTRAL, 0.7, 1.4);
      pts += poissonTail(threshold, lambda) * DEFCON_PTS;
    }

    // --- bonus: empirical bonus per 90, tilted by fixture ease.
    var bonus90 = minutes >= 270 ? per90(num(player.bonus), minutes) : 0.12;
    pts += bonus90 * share * clamp(attMult, 0.7, 1.4);

    // --- cards
    pts -= per90(num(player.yellow_cards), minutes) * share;
    pts -= per90(num(player.red_cards), minutes) * share * 3;

    return {
      points: pts,
      opponent: opponent,
      isHome: isHome,
      teamXG: goals.xG,
      teamXGC: goals.xGC
    };
  }

  // ------------------------------------------------------------------ context

  /**
   * Pre-compute everything the per-player calls need, once per data refresh.
   *
   * @param {object} bootstrap bootstrap-static payload
   * @param {Array}  fixtures  fixtures payload
   */
  function buildContext(bootstrap, fixtures) {
    var teamsById = {};
    bootstrap.teams.forEach(function (t) { teamsById[t.id] = t; });

    var avg = leagueAverages(bootstrap.teams);
    var targetGw = currentGameweek(bootstrap.events);

    // Games played per team, the denominator for minutes-per-game.
    var gamesPlayed = {};
    bootstrap.teams.forEach(function (t) {
      gamesPlayed[t.id] = num(t.played);
    });
    var maxPlayed = 0;
    Object.keys(gamesPlayed).forEach(function (id) {
      if (gamesPlayed[id] > maxPlayed) maxPlayed = gamesPlayed[id];
    });

    if (!maxPlayed) {
      // `played` can lag early on, so fall back to finished gameweeks. And in
      // the off-season nothing has been played at all while `minutes` still
      // holds last season's totals — those need a full 38-game denominator or
      // every squad player looks nailed to start.
      var finished = bootstrap.events.filter(function (e) { return e.finished; }).length;
      var carryOverMinutes = !finished && bootstrap.elements.some(function (p) {
        return num(p.minutes) > 0;
      });
      var fallback = finished || (carryOverMinutes ? 38 : 0);
      bootstrap.teams.forEach(function (t) { gamesPlayed[t.id] = fallback; });
    }

    // team id -> gameweek -> [fixture, ...]  (an array, so doubles survive)
    var byTeamGw = {};
    function push(teamId, gw, entry) {
      if (!gw) return; // unscheduled fixtures have event === null
      if (!byTeamGw[teamId]) byTeamGw[teamId] = {};
      if (!byTeamGw[teamId][gw]) byTeamGw[teamId][gw] = [];
      byTeamGw[teamId][gw].push(entry);
    }

    fixtures.forEach(function (f) {
      if (f.finished || f.finished_provisional) return;
      push(f.team_h, f.event, {
        gw: f.event,
        opponentId: f.team_a,
        isHome: true,
        difficulty: f.team_h_difficulty,
        kickoff: f.kickoff_time
      });
      push(f.team_a, f.event, {
        gw: f.event,
        opponentId: f.team_h,
        isHome: false,
        difficulty: f.team_a_difficulty,
        kickoff: f.kickoff_time
      });
    });

    return {
      bootstrap: bootstrap,
      teamsById: teamsById,
      averages: avg,
      gamesPlayed: gamesPlayed,
      byTeamGw: byTeamGw,
      targetGw: targetGw,
      elementTypes: bootstrap.element_types
    };
  }

  /**
   * The gameweek the user is currently interested in: the live one if a
   * gameweek is in progress, otherwise the one they are picking for.
   */
  function currentGameweek(events) {
    var live = events.find(function (e) { return e.is_current && !e.finished; });
    if (live) return live.id;
    var next = events.find(function (e) { return e.is_next; });
    if (next) return next.id;
    var unfinished = events.find(function (e) { return !e.finished; });
    return unfinished ? unfinished.id : (events.length ? events[events.length - 1].id : 1);
  }

  /** Latest gameweek whose deadline has passed — the newest picks we can read. */
  function latestStartedGameweek(events) {
    var now = Date.now();
    var best = null;
    events.forEach(function (e) {
      if (new Date(e.deadline_time).getTime() <= now) {
        if (!best || e.id > best) best = e.id;
      }
    });
    return best;
  }

  // -------------------------------------------------------------- public API

  /**
   * Next `count` gameweeks of fixtures for a team, as display-ready chips.
   * Blank gameweeks are included as a placeholder so the strip stays aligned.
   */
  function fixtureStrip(ctx, teamId, count, fromGw) {
    var start = fromGw || ctx.targetGw;
    var out = [];
    var gwMap = ctx.byTeamGw[teamId] || {};

    for (var i = 0; i < (count || 5); i++) {
      var gw = start + i;
      var list = gwMap[gw];
      if (!list || !list.length) {
        out.push({ gw: gw, blank: true, label: '—', difficulty: 3, title: 'GW' + gw + ': blank gameweek' });
        continue;
      }
      list.forEach(function (f) {
        var opp = ctx.teamsById[f.opponentId];
        var short = opp ? opp.short_name : '???';
        out.push({
          gw: gw,
          blank: false,
          isHome: f.isHome,
          // Uppercase = home, lowercase = away, the usual FPL shorthand.
          label: f.isHome ? short.toUpperCase() : short.toLowerCase(),
          opponent: short,
          difficulty: f.difficulty,
          double: list.length > 1,
          title: 'GW' + gw + ': ' + short + ' (' + (f.isHome ? 'H' : 'A') + ') · FDR ' + f.difficulty
        });
      });
    }
    return out;
  }

  /**
   * Expected points for a player in the target gameweek (summed across a
   * double gameweek, 0 for a blank).
   */
  function playerXP(ctx, player, gw) {
    var targetGw = gw || ctx.targetGw;
    var team = ctx.teamsById[player.team];
    var mins = minutesModel(player, ctx.gamesPlayed[player.team]);
    var list = (ctx.byTeamGw[player.team] || {})[targetGw] || [];

    var result = {
      gw: targetGw,
      fixtures: [],
      xMins: mins.xMins,
      blank: list.length === 0,
      double: list.length > 1,
      unavailable: !mins.available,
      modelXP: 0,
      // ep_this is null outside a live gameweek; ep_next covers the off-season.
      fplEp: num(player.ep_this, num(player.ep_next, NaN)),
      xp: 0
    };

    if (!team || !list.length) {
      // No fixture: nothing to score. Keep ep for reference but report 0.
      result.xp = 0;
      return result;
    }

    var total = 0;
    list.forEach(function (f) {
      var opp = ctx.teamsById[f.opponentId];
      if (!opp) return;
      var r = fixtureXP(player, team, opp, f.isHome, mins, ctx.averages, f.difficulty);
      total += r.points;
      result.fixtures.push({
        opponent: opp.short_name,
        isHome: f.isHome,
        difficulty: f.difficulty,
        points: r.points
      });
    });

    result.modelXP = Math.max(0, total);

    // Injured, suspended or out of the squad: no blend, they cannot score.
    if (result.unavailable) {
      result.xp = 0;
      return result;
    }

    // With little evidence of a player's own rates, lean on FPL's own estimate.
    // Under a full game of minutes the model has nothing to say, so defer to it
    // entirely rather than reporting a confident zero.
    var playerMinutes = num(player.minutes);
    var trust = playerMinutes < 90 ? 0 : clamp(playerMinutes / MINUTES_FOR_FULL_TRUST, 0.25, 1);
    var ep = result.fplEp;
    if (isFinite(ep) && trust < 1) {
      // ep_this is a single-fixture figure; scale it for a double gameweek.
      var epScaled = ep * (result.double ? 1.8 : 1);
      result.xp = trust * result.modelXP + (1 - trust) * epScaled;
    } else {
      result.xp = result.modelXP;
    }

    result.xp = Math.max(0, result.xp);
    return result;
  }

  function fdrColour(difficulty) {
    return FDR_COLOURS[difficulty] || FDR_COLOURS[3];
  }

  function positionShort(ctx, elementType) {
    var t = (ctx.elementTypes || []).find(function (p) { return p.id === elementType; });
    return t ? t.singular_name_short : '?';
  }

  root.FPLXP = {
    buildContext: buildContext,
    playerXP: playerXP,
    fixtureStrip: fixtureStrip,
    fdrColour: fdrColour,
    positionShort: positionShort,
    currentGameweek: currentGameweek,
    latestStartedGameweek: latestStartedGameweek,
    FDR_COLOURS: FDR_COLOURS
  };
})(typeof self !== 'undefined' ? self : this);
