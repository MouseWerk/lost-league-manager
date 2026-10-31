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

  const api = { itemGold, kills, objectives, killParticipation, laneOpponent, teamOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OverlayStats = api;
})(this);
