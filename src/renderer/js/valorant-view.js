// Valorant in the renderer: the League / Valorant switch in the top bar, the
// Valorant rank in the account list, the Valorant part of the account panel
// (rank, wallet, store, last games, skins) and the loadout dialog.
// Loaded after app.js and uses its globals (allAccounts, selectedAccount,
// showToast, openLayer, ...). Text from Valorant or valorant-api.com goes in
// through textContent only.

let currentGameValue = "lol";
let _valView = null;     // the selected account's Valorant view (main process)
let _valViewFor = null;  // its username
let _loadout = null;     // { username, weapons, canEquip, weaponId, skinId, chromaId, levelId }

function currentGame() {
  return currentGameValue;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function img(src, cls, alt = "") {
  const i = document.createElement("img");
  if (cls) i.className = cls;
  i.alt = alt;
  i.loading = "lazy";
  if (src) i.src = src;
  i.addEventListener("error", () => i.classList.add("is-missing"), { once: true });
  return i;
}

const n = (v) => (v == null ? "-" : Number(v).toLocaleString());

// ── The switch ──────────────────────────────────────────────────────────────

function applyGame(game) {
  currentGameValue = game === "valorant" ? "valorant" : "lol";
  document.body.dataset.game = currentGameValue;
  document.querySelectorAll(".game-switch-btn").forEach((b) => {
    const on = b.dataset.game === currentGameValue;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

async function setGame(game) {
  if (game === currentGameValue) return;
  applyGame(game);
  const res = await window.electronAPI.setConfig({ game: currentGameValue });
  if (res && res.success === false) showToast(res.message || "Could not switch the game", "error");
  renderAccounts();
  const acc = selectedAccount();
  if (acc) selectAccount(acc.username);
}

function initGameSwitch(config) {
  applyGame(config?.game);
  document.querySelectorAll(".game-switch-btn").forEach((b) =>
    b.addEventListener("click", () => setGame(b.dataset.game)),
  );
}

// ── Account list ────────────────────────────────────────────────────────────

// The rank cell and facts of a row in Valorant mode.
function decorateValorantCard(card, account) {
  if (currentGameValue !== "valorant") return;
  const v = account?.valorant;
  const rankEl = card.querySelector(".card-rank");
  if (rankEl) {
    rankEl.className = "rank card-rank val-rank";
    rankEl.replaceChildren();
    delete rankEl.dataset.tooltip;
    if (v && v.tier != null) {
      if (v.tierIcon) rankEl.appendChild(img(v.tierIcon, "card-emblem"));
      const text = el("span", "card-rank-text");
      text.appendChild(el("span", "card-tier", v.tierName || "Unrated"));
      if (v.tier > 2) text.appendChild(el("span", "card-lp", `${v.rr ?? 0} RR`));
      rankEl.appendChild(text);
    } else {
      rankEl.appendChild(el("span", "card-rank-text val-rank-none", "Not read yet"));
      rankEl.dataset.tooltip = "Play this account with Valorant selected to read its rank";
    }
  }
  const facts = card.querySelector(".card-facts");
  if (facts && v?.vp != null) {
    const f = el("span", "card-fact card-fact-vp", `${compactNumber(v.vp)} VP`);
    facts.appendChild(f);
  }
}

// ── Account panel ───────────────────────────────────────────────────────────

async function renderValorantPanel(acc) {
  const wrap = document.getElementById("valorantPanel");
  if (!wrap || currentGameValue !== "valorant" || !acc) return;
  const username = acc.username;
  if (_valViewFor !== username) {
    _valView = null;
    _valViewFor = username;
    paintValorantPanel(acc, null);
  }
  const res = await window.electronAPI.valorantAccount(username);
  if (_valViewFor !== username) return;
  _valView = res?.success ? res.view : null;
  paintValorantPanel(acc, _valView);
}

function paintValorantPanel(acc, view) {
  const rank = view?.rank;
  const icon = document.getElementById("valRankIcon");
  icon.hidden = !rank?.current?.icon;
  if (rank?.current?.icon) icon.src = rank.current.icon;
  document.getElementById("valRankName").textContent = rank ? rank.current.name : "Not read yet";
  const sub = [];
  if (rank && rank.current.tier > 2) sub.push(`${rank.rr} RR`);
  if (rank?.games) sub.push(`${rank.wins ?? 0}W ${rank.games - (rank.wins ?? 0)}L this act`);
  if (rank && rank.peak?.tier > 2) sub.push(`Peak ${rank.peak.name}`);
  document.getElementById("valRankSub").textContent = sub.join(", ");
  const src = rank?.source === "henrik" ? "from HenrikDev" : "at last sign-in";
  document.getElementById("valRankWhen").textContent = rank?.checkedAt ? `${src}, ${timeAgo(rank.checkedAt)}` : "";

  // Wallet with Valorant's own currency icons.
  const wallet = document.getElementById("valWallet");
  wallet.replaceChildren();
  const w = view?.wallet;
  wallet.hidden = !w;
  if (w) {
    for (const [key, label] of [["vp", "VP"], ["rad", "Radianite"], ["kc", "Kingdom Credits"]]) {
      if (w[key] == null) continue;
      const item = el("span", "profile-wallet-item");
      if (view.currencyIcons?.[key]) item.appendChild(img(view.currencyIcons[key], "currency-icon"));
      const b = el("b", null, n(w[key]));
      item.append(b, ` ${label}`);
      wallet.appendChild(item);
    }
  }

  paintStore(view);
  paintMatches(view);

  const skinsBtn = document.getElementById("valSkinsBtn");
  const owned = view?.owned?.length || 0;
  skinsBtn.textContent = owned ? `${owned} skins` : "Skins";
  skinsBtn.disabled = !owned;
  document.getElementById("valHint").textContent = view
    ? ""
    : "Play this account with Valorant selected to read its rank, store and skins.";
}

function paintStore(view) {
  const wrap = document.getElementById("valStoreWrap");
  const s = view?.store;
  wrap.hidden = !s || !s.daily?.length;
  if (wrap.hidden) return;
  const now = Date.now();
  const left = (t) => (t && t > now ? UiLib.timeLeft(t - now) : "");
  document.getElementById("valStoreWhen").textContent = s.dailyEndsAt
    ? s.dailyEndsAt > now ? `changes in ${left(s.dailyEndsAt)}` : `seen ${timeAgo(s.checkedAt)}, changed since`
    : "";
  const grid = document.getElementById("valStoreGrid");
  grid.replaceChildren(...s.daily.map((o) => storeTile(o, view)));
  const night = document.getElementById("valNightWrap");
  night.hidden = !(s.night?.length && s.nightEndsAt > now);
  if (!night.hidden) {
    document.getElementById("valNightWhen").textContent = `ends in ${left(s.nightEndsAt)}`;
    document.getElementById("valNightGrid").replaceChildren(...s.night.map((o) => storeTile(o, view, true)));
  }
}

function storeTile(o, view, night = false) {
  const tile = el("div", "val-store-tile");
  tile.appendChild(img(o.icon, "val-store-img"));
  tile.appendChild(el("span", "val-store-name", o.name));
  const price = el("span", "val-store-price");
  if (view.currencyIcons?.vp) price.appendChild(img(view.currencyIcons.vp, "currency-icon"));
  if (night && o.discounted != null) {
    price.appendChild(el("b", null, n(o.discounted)));
    price.appendChild(el("s", "val-store-was", n(o.cost)));
    if (o.percent != null) price.appendChild(el("span", "val-store-off", `-${o.percent}%`));
  } else {
    price.appendChild(el("b", null, n(o.cost)));
  }
  tile.appendChild(price);
  return tile;
}

function paintMatches(view) {
  const wrap = document.getElementById("valMatchesWrap");
  const list = view?.matches || [];
  wrap.hidden = !list.length;
  const box = document.getElementById("valMatches");
  box.replaceChildren();
  for (const m of list.slice(0, 6)) {
    const row = el("div", `val-match ${m.won ? "is-win" : m.draw ? "is-draw" : "is-loss"}`);
    row.appendChild(img(m.agentIcon, "val-match-agent"));
    const main = el("span", "val-match-main");
    main.appendChild(el("span", "val-match-map", m.map || "Unknown map"));
    main.appendChild(el("span", "val-match-sub", [m.agent, m.ranked ? "Competitive" : m.queue ? m.queue.charAt(0).toUpperCase() + m.queue.slice(1) : "", m.start ? timeAgo(m.start) : ""].filter(Boolean).join(", ")));
    row.appendChild(main);
    row.appendChild(el("span", "val-match-kda", `${m.kills}/${m.deaths}/${m.assists}`));
    row.appendChild(el("span", "val-match-score", m.rounds ? `${m.rounds[0]}-${m.rounds[1]}` : m.won ? "Win" : "Loss"));
    box.appendChild(row);
  }
}

async function refreshValorant() {
  const acc = selectedAccount();
  if (!acc) return;
  const btn = document.getElementById("valRefreshBtn");
  btn.disabled = true;
  try {
    const res = await window.electronAPI.valorantRefresh(acc.username);
    if (!res?.success) showToast(res?.message || "Could not read Valorant", "info");
    else showToast(res.source === "henrik" ? "Rank read from HenrikDev" : "Valorant read from the client", "success");
    _valViewFor = null;
    await renderValorantPanel(acc);
  } finally {
    btn.disabled = false;
  }
}

function openValorantSkins() {
  const acc = selectedAccount();
  if (!acc || !_valView?.owned?.length) return;
  openCollectionList(acc, {
    skins: _valView.owned.map((s) => ({ id: s.id, name: s.name, icon: s.icon, weapon: s.weapon })),
    champions: null,
    checkedAt: _valView.checkedAt,
  });
}

// ── Loadout ─────────────────────────────────────────────────────────────────

async function openLoadout() {
  const acc = selectedAccount();
  if (!acc) return;
  const res = await window.electronAPI.valorantLoadout(acc.username);
  if (!res?.success) {
    showToast(res?.message || "Could not read the loadout", "info");
    return;
  }
  _loadout = { username: acc.username, weapons: res.weapons, canEquip: res.canEquip, weaponId: res.weapons[0]?.id || null, pick: null };
  document.getElementById("loadoutAccount").textContent = acc.label || acc.riotId || acc.username;
  document.getElementById("loadoutReadOnly").hidden = res.canEquip;
  const auto = document.getElementById("loadoutAutoSets");
  const cfg = await window.electronAPI.getConfig();
  auto.checked = !!cfg.valorantAutoSets;
  renderLoadout();
  renderSets();
  openLayer(document.getElementById("loadoutModal"), { onEscape: closeLoadout });
}

function closeLoadout() {
  closeLayer(document.getElementById("loadoutModal"));
  _loadout = null;
}

function equippedSkin(w) {
  return w.skins.find((s) => s.id === w.equipped?.skinId) || null;
}

function renderLoadout() {
  if (!_loadout) return;
  const list = document.getElementById("loadoutWeapons");
  list.replaceChildren();
  let category = null;
  for (const w of _loadout.weapons) {
    if (w.category !== category) {
      category = w.category;
      list.appendChild(el("div", "loadout-cat", category || "Other"));
    }
    const b = el("button", `loadout-weapon${w.id === _loadout.weaponId ? " active" : ""}`);
    b.type = "button";
    b.dataset.weapon = w.id;
    const skin = equippedSkin(w);
    b.appendChild(img(skin?.icon || w.icon, "loadout-weapon-img"));
    const t = el("span", "loadout-weapon-text");
    t.appendChild(el("span", "loadout-weapon-name", w.name));
    t.appendChild(el("span", "loadout-weapon-skin", skin?.name || "Standard"));
    b.appendChild(t);
    list.appendChild(b);
  }
  renderSkinPicker();
}

function renderSkinPicker() {
  const w = _loadout.weapons.find((x) => x.id === _loadout.weaponId);
  const box = document.getElementById("loadoutSkins");
  const detail = document.getElementById("loadoutDetail");
  box.replaceChildren();
  detail.replaceChildren();
  if (!w) return;
  document.getElementById("loadoutWeaponTitle").textContent = w.name;
  const filter = document.getElementById("loadoutFilter").value.trim().toLowerCase();
  const pickId = _loadout.pick?.skinId || w.equipped?.skinId;
  for (const s of w.skins.filter((x) => !filter || x.name.toLowerCase().includes(filter))) {
    const t = el("button", `collection-tile loadout-skin${s.id === pickId ? " active" : ""}${s.id === w.equipped?.skinId ? " is-equipped" : ""}`);
    t.type = "button";
    t.dataset.skin = s.id;
    t.appendChild(img(s.icon, null));
    t.appendChild(el("span", "collection-name", s.name));
    box.appendChild(t);
  }
  const skin = w.skins.find((s) => s.id === pickId);
  if (!skin) return;
  const pick = _loadout.pick?.skinId === skin.id ? _loadout.pick : { skinId: skin.id, chromaId: w.equipped?.chromaId, levelId: w.equipped?.levelId };
  _loadout.pick = pick;
  if (skin.chromas.length > 1) {
    const row = el("div", "loadout-chromas");
    row.appendChild(el("span", "loadout-label", "Chroma"));
    for (const c of skin.chromas) {
      const b = el("button", `loadout-chroma${c.id === (pick.chromaId || skin.chromas[0].id) ? " active" : ""}`);
      b.type = "button";
      b.dataset.chroma = c.id;
      b.dataset.tooltip = c.name;
      b.setAttribute("aria-label", c.name);
      b.appendChild(img(c.swatch || c.icon, null));
      row.appendChild(b);
    }
    detail.appendChild(row);
  }
  if (skin.levels.length > 1) {
    const row = el("label", "loadout-levels");
    row.appendChild(el("span", "loadout-label", "Level"));
    const sel = el("select", "form-control loadout-level");
    skin.levels.forEach((l, i) => {
      const o = el("option", null, `Level ${i + 1}`);
      o.value = l.id;
      if (l.id === (pick.levelId || skin.levels[skin.levels.length - 1].id)) o.selected = true;
      sel.appendChild(o);
    });
    row.appendChild(sel);
    detail.appendChild(row);
  }
  const equip = el("button", "primary-btn loadout-equip", w.equipped?.skinId === skin.id && w.equipped?.chromaId === pick.chromaId && w.equipped?.levelId === pick.levelId ? "Equipped" : `Equip ${skin.name}`);
  equip.type = "button";
  equip.id = "loadoutEquipBtn";
  equip.disabled = !_loadout.canEquip;
  detail.appendChild(equip);
}

async function equipPick() {
  const w = _loadout?.weapons.find((x) => x.id === _loadout.weaponId);
  const skin = w?.skins.find((s) => s.id === _loadout.pick?.skinId);
  if (!skin) return;
  const levelSel = document.querySelector(".loadout-level");
  const guns = {
    [w.id]: {
      skinId: skin.id,
      chromaId: _loadout.pick.chromaId || skin.chromas[0]?.id || null,
      // Without a choice: the highest owned level, as the game does.
      levelId: levelSel ? levelSel.value : skin.levels[skin.levels.length - 1]?.id || null,
    },
  };
  await sendGuns(guns, `${skin.name} equipped`);
}

async function sendGuns(guns, okText) {
  const res = await window.electronAPI.valorantEquip(_loadout.username, guns);
  if (!res?.success) {
    showToast(res?.message || "Valorant did not take the loadout", "error");
    return;
  }
  for (const w of _loadout.weapons) if (res.loadout?.[w.id]) w.equipped = res.loadout[w.id];
  showToast(okText, "success");
  renderLoadout();
}

// Saved sets: the whole current loadout under a name, optionally for an agent.
function renderSets() {
  const box = document.getElementById("loadoutSets");
  box.replaceChildren();
  const sets = _valView?.sets || [];
  for (const s of sets) {
    const row = el("div", "loadout-set");
    const t = el("span", "loadout-set-name", s.name);
    row.appendChild(t);
    row.appendChild(el("span", "loadout-set-agent", s.agent ? `for ${s.agent}` : ""));
    const apply = el("button", "action-btn", "Equip");
    apply.type = "button";
    apply.dataset.applySet = s.id;
    apply.disabled = !_loadout?.canEquip;
    const del = el("button", "icon-btn", "");
    del.type = "button";
    del.dataset.deleteSet = s.id;
    del.setAttribute("aria-label", `Delete ${s.name}`);
    del.dataset.tooltip = "Delete";
    del.innerHTML = '<i class="fas fa-trash" aria-hidden="true"></i>';
    row.append(apply, del);
    box.appendChild(row);
  }
  if (!sets.length) box.appendChild(el("p", "games-note", "No sets yet. Save your current loadout as one."));
  const agentSel = document.getElementById("loadoutSetAgent");
  if (agentSel.options.length <= 1) {
    for (const a of _valView?.agents || []) {
      const o = el("option", null, a.name);
      o.value = a.id;
      agentSel.appendChild(o);
    }
  }
}

async function saveCurrentAsSet() {
  const name = document.getElementById("loadoutSetName").value.trim();
  if (!name) {
    showToast("Give the set a name", "info");
    return;
  }
  const guns = {};
  for (const w of _loadout.weapons) if (w.equipped?.skinId) guns[w.id] = w.equipped;
  const agentId = document.getElementById("loadoutSetAgent").value || null;
  const res = await window.electronAPI.valorantSaveSet(_loadout.username, { name, agentId, guns });
  if (!res?.success) {
    showToast(res?.message || "Could not save the set", "error");
    return;
  }
  document.getElementById("loadoutSetName").value = "";
  _valView = { ..._valView, sets: res.sets.map((s) => ({ ...s, agent: (_valView?.agents || []).find((a) => a.id === s.agentId)?.name || "" })) };
  renderSets();
  showToast(`Set "${name}" saved`, "success");
}

function initValorant() {
  document.getElementById("valRefreshBtn")?.addEventListener("click", refreshValorant);
  document.getElementById("valSkinsBtn")?.addEventListener("click", openValorantSkins);
  document.getElementById("valLoadoutBtn")?.addEventListener("click", openLoadout);
  document.getElementById("closeLoadoutBtn")?.addEventListener("click", closeLoadout);
  document.getElementById("loadoutModal")?.addEventListener("click", (e) => {
    if (e.target.id === "loadoutModal") return closeLoadout();
    const weapon = e.target.closest("[data-weapon]");
    if (weapon && _loadout) {
      _loadout.weaponId = weapon.dataset.weapon;
      _loadout.pick = null;
      document.getElementById("loadoutFilter").value = "";
      return renderLoadout();
    }
    const skin = e.target.closest("[data-skin]");
    if (skin && _loadout) {
      _loadout.pick = { skinId: skin.dataset.skin, chromaId: null, levelId: null };
      return renderSkinPicker();
    }
    const chroma = e.target.closest("[data-chroma]");
    if (chroma && _loadout?.pick) {
      _loadout.pick.chromaId = chroma.dataset.chroma;
      return renderSkinPicker();
    }
    if (e.target.closest("#loadoutEquipBtn")) return equipPick();
    const apply = e.target.closest("[data-apply-set]");
    if (apply) {
      const set = (_valView?.sets || []).find((s) => s.id === apply.dataset.applySet);
      if (set) sendGuns(set.guns, `Set "${set.name}" equipped`);
      return;
    }
    const del = e.target.closest("[data-delete-set]");
    if (del && _loadout) {
      window.electronAPI.valorantDeleteSet(_loadout.username, del.dataset.deleteSet).then((res) => {
        if (res?.success) {
          _valView = { ..._valView, sets: (_valView?.sets || []).filter((s) => s.id !== del.dataset.deleteSet) };
          renderSets();
        }
      });
    }
  });
  document.getElementById("loadoutFilter")?.addEventListener("input", () => _loadout && renderSkinPicker());
  document.getElementById("loadoutSaveSetBtn")?.addEventListener("click", saveCurrentAsSet);
  document.getElementById("loadoutAutoSets")?.addEventListener("change", async (e) => {
    const res = await window.electronAPI.setConfig({ valorantAutoSets: e.target.checked });
    if (res && res.success === false) showToast(res.message || "Could not save", "error");
  });
}
