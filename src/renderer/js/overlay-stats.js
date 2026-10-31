// Game numbers for the overlay's Game and Players panels, from Live Client
// data (all_players, events). Only what the scoreboard (Tab) and the kill
// feed show in the game; no timers. Loaded before overlay.js; tests require it.
(function (root) {
  "use strict";

  const OBJECTIVES = {
    DragonKill: "dragons",
    BaronKill: "barons",
    HeraldKill: "heralds",
    HordeKill: "grubs",
    AtakhanKill: "atakhan",
  };

  function teamOf(players, name) {
    const p = (players || []).find((x) => x.riotIdGameName === name || x.summonerName === name || x.riotId === name);
    return p ? p.team : null;
  }

  // Item value a team holds (what Tab shows as items), not gold earned.
  function itemGold(players, team) {
    let sum = 0;
    for (const p of players || []) {
      if (p.team !== team) continue;
      for (const it of p.items || []) sum += (it.price || 0) * (it.count || 1);
    }
    return sum;
  }

  function kills(players, team) {
    return (players || []).filter((p) => p.team === team).reduce((s, p) => s + (p.scores?.kills || 0), 0);
  }

  // Towers and the big monsters per team, from the game's event feed.
  // A tower named Turret_T1_... belongs to blue (ORDER), so red took it.
  function objectives(events, players) {
    const blank = () => ({ towers: 0, inhibitors: 0, dragons: 0, barons: 0, heralds: 0, grubs: 0, atakhan: 0 });
    const out = { ORDER: blank(), CHAOS: blank() };
    for (const e of events || []) {
      if (e.EventName === "TurretKilled" || e.EventName === "InhibKilled") {
        const name = String(e.TurretKilled || e.InhibKilled || "");
        const owner = /_T1_|_T100_/.test(name) ? "ORDER" : /_T2_|_T200_/.test(name) ? "CHAOS" : null;
        if (!owner) continue;
        const taker = owner === "ORDER" ? "CHAOS" : "ORDER";
        out[taker][e.EventName === "TurretKilled" ? "towers" : "inhibitors"]++;
        continue;
      }
      const key = OBJECTIVES[e.EventName];
      if (!key) continue;
      const team = teamOf(players, e.KillerName);
      if (team && out[team]) out[team][key]++;
    }
    return out;
  }

  // Share of the team's kills you took part in, 0-100, or null before any.
  function killParticipation(me, players) {
    if (!me) return null;
    const team = kills(players, me.team);
    if (!team) return null;
    return Math.round((((me.scores?.kills || 0) + (me.scores?.assists || 0)) / team) * 100);
  }

  // The enemy in your position (lane opponent), when positions are known.
  function laneOpponent(me, players) {
    if (!me || !me.position || me.position === "NONE") return null;
    return (players || []).find((p) => p.team !== me.team && p.position === me.position) || null;
  }

  // Short labels for a player, as Porofessor shows them, from their solo
  // record (wins, losses / winLose) and season games on the champion they
  // play (overlay-handlers.js championRecord). Most telling first.
  function playerTags(rec, championName) {
    const tags = [];
    if (!rec) return tags;
    const m = /(\d+)W\s+(\d+)L/.exec(rec.winLose || "");
    const wins = m ? Number(m[1]) : 0;
    const losses = m ? Number(m[2]) : 0;
    const games = rec.games ?? (m ? wins + losses : null);
    const champGames = rec.champGames;
    if (typeof champGames === "number" && games) {
      if (champGames >= 20 && champGames / games >= 0.5) tags.push({ text: "One-trick", tone: "info" });
      else if (championName && rec.mainChampion && rec.mainChampion === championName && champGames >= 10) tags.push({ text: "Main", tone: "info" });
      if (champGames === 0 && rec.poolSize >= 10 && games >= 30) tags.push({ text: "New on champ", tone: "good" });
      if (champGames >= 10) {
        const wr = Math.round((rec.champWins / champGames) * 100);
        if (wr >= 60) tags.push({ text: `${wr}% on champ`, tone: "bad" });
      }
    }
    if (games !== null && games !== undefined) {
      if (games > 0 && games < 15) tags.push({ text: "Few games", tone: "neutral" });
      if (games >= 20) {
        const wr = Math.round((wins / games) * 100);
        if (wr >= 60) tags.push({ text: "High win rate", tone: "bad" });
        else if (wr <= 43) tags.push({ text: "Low win rate", tone: "good" });
      }
    }
    return tags;
  }

  // When objectives come back after being taken (what the kill feed and the
  // game's own timers show): next dragon, baron, and each inhibitor.
  // Seconds of game time; only future ones are returned.
  const RESPAWN = { DragonKill: 300, BaronKill: 360, InhibKilled: 300 };
  function objectiveTimers(events, gameTime) {
    const out = [];
    let dragon = null;
    let baron = null;
    const inhibs = {};
    for (const e of events || []) {
      if (e.EventName === "DragonKill" && !/Elder/i.test(e.DragonType || "")) dragon = Math.max(dragon || 0, e.EventTime + RESPAWN.DragonKill);
      if (e.EventName === "BaronKill") baron = Math.max(baron || 0, e.EventTime + RESPAWN.BaronKill);
      if (e.EventName === "InhibKilled") inhibs[e.InhibKilled] = e.EventTime + RESPAWN.InhibKilled;
    }
    if (dragon && dragon > gameTime) out.push({ name: "Dragon", at: dragon });
    if (baron && baron > gameTime) out.push({ name: "Baron", at: baron });
    for (const [id, at] of Object.entries(inhibs)) {
      if (at <= gameTime) continue;
      const side = /_T1_|_T100_/.test(id) ? "Blue" : "Red";
      out.push({ name: `${side} inhibitor`, at });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  const api = { itemGold, kills, objectives, killParticipation, laneOpponent, teamOf, playerTags, objectiveTimers };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OverlayStats = api;
})(this);
