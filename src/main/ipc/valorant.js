const { ipcMain } = require('electron');
const state = require('../state');
const valorant = require('../services/valorant');
const { loadAccounts } = require('../services/storage');

// Valorant for the renderer: one account's rank, matches, wallet, store,
// owned skins and loadout, resolved to names and pictures; refresh; equip;
// saved sets. Nothing while the vault is locked.

const locked = () => require('../services/vault').isVaultLocked();
const LOCKED = Object.freeze({ success: false, locked: true, message: 'Vault is locked' });

function findAccount(username) {
    if (typeof username !== 'string') return null;
    return loadAccounts().find((a) => a.username.toLowerCase() === username.toLowerCase()) || null;
}

// What the account list needs: rank, wallet and owned skin names (search).
function summaryFor(rec, c) {
    if (!rec) return null;
    const { byLevel } = valorant.indexContent(c);
    const names = [];
    for (const id of rec.owned?.skinLevels || []) {
        const e = byLevel.get(id);
        if (e && e.skin.levels[0]?.id === id) names.push(e.skin.name);
    }
    const tier = rec.rank?.tier ?? null;
    return {
        tierName: tier === null ? null : valorant.tierName(tier),
        tierIcon: tier === null ? null : (c.tiers || []).find((t) => t.tier === tier)?.icon || null,
        tier,
        rr: rec.rank?.rr ?? null,
        peakTier: rec.rank?.peakTier ?? null,
        rankSource: rec.rank?.source || null,
        vp: rec.wallet?.vp ?? null,
        checkedAt: rec.checkedAt || rec.rank?.checkedAt || null,
        names,
    };
}

// The account's record with names and pictures filled in.
function viewFor(rec, c) {
    if (!rec) return null;
    const { byLevel } = valorant.indexContent(c);
    const tiers = new Map((c.tiers || []).map((t) => [t.tier, t]));
    const agents = new Map((c.agents || []).map((a) => [a.id.toLowerCase(), a]));
    const maps = new Map((c.maps || []).map((m) => [m.path, m]));
    const contentTiers = new Map((c.contentTiers || []).map((t) => [t.id, t]));
    const tierInfo = (t) => ({ tier: t ?? 0, name: valorant.tierName(t ?? 0), icon: tiers.get(t ?? 0)?.icon || null });
    const skinOf = (levelId) => {
        const e = byLevel.get(levelId);
        return e ? { name: e.skin.name, icon: e.skin.icon, weapon: e.weapon.name, tierIcon: contentTiers.get(e.skin.tier)?.icon || null } : { name: 'Unknown skin', icon: null, weapon: '', tierIcon: null };
    };
    const owned = [];
    for (const id of rec.owned?.skinLevels || []) {
        const e = byLevel.get(id);
        if (e && e.skin.levels[0]?.id === id) owned.push({ id: e.skin.id, name: e.skin.name, icon: e.skin.icon, weapon: e.weapon.name });
    }
    owned.sort((a, b) => a.weapon.localeCompare(b.weapon) || a.name.localeCompare(b.name));
    return {
        rank: rec.rank ? { ...rec.rank, current: tierInfo(rec.rank.tier), peak: tierInfo(rec.rank.peakTier) } : null,
        wallet: rec.wallet || null,
        store: rec.store ? {
            ...rec.store,
            daily: rec.store.daily.map((o) => ({ ...o, ...skinOf(o.levelId) })),
            night: (rec.store.night || []).map((o) => ({ ...o, ...skinOf(o.levelId) })),
        } : null,
        matches: (rec.matches || []).map((m) => {
            const a = agents.get(String(m.agentId).toLowerCase());
            const map = maps.get(m.mapId);
            return { ...m, agent: a?.name || '', agentIcon: a?.icon || null, map: map?.name || '', tierName: valorant.tierName(m.tier) };
        }),
        owned,
        agentsOwned: (rec.owned?.agents || []).length,
        sets: (rec.sets || []).map((s) => ({ ...s, agent: s.agentId ? agents.get(s.agentId.toLowerCase())?.name || '' : '' })),
        agents: (c.agents || []).map((a) => ({ id: a.id, name: a.name, icon: a.icon })).sort((x, y) => x.name.localeCompare(y.name)),
        checkedAt: rec.checkedAt || null,
        shard: rec.shard || null,
        // Valorant's own currency icons, by wallet key.
        currencyIcons: Object.fromEntries(Object.entries(valorant.CURRENCIES).map(([k, id]) => [k, (c.currencies || []).find((x) => x.id === id)?.icon || null])),
    };
}

function register() {
    ipcMain.handle('valorant-account', async (event, username) => {
        if (locked()) return LOCKED;
        const acc = findAccount(username);
        if (!acc) return { success: false, message: 'Account not found' };
        const c = await valorant.getContent();
        return { success: true, view: viewFor(valorant.getRecord(acc.username), c) };
    });

    // Reads the account from the Riot Client when it is the one signed in;
    // otherwise its rank from HenrikDev when a key is set.
    ipcMain.handle('valorant-refresh', async (event, username) => {
        if (locked()) return LOCKED;
        const acc = findAccount(username);
        if (!acc) return { success: false, message: 'Account not found' };
        try {
            if (await valorant.captureForAccount(acc.username)) {
                require('../windows').broadcastAccountsUpdate();
                return { success: true, source: 'client' };
            }
            if (require('../services/secrets').hasHenrikKey()) {
                if (await valorant.henrikRank(acc)) {
                    require('../windows').broadcastAccountsUpdate();
                    return { success: true, source: 'henrik' };
                }
                return { success: false, message: 'HenrikDev has no Valorant rank for this Riot ID.' };
            }
        } catch (e) {
            const status = e.response?.status;
            return { success: false, message: status === 401 || status === 403 ? 'The HenrikDev key was refused. Check it in Settings.' : `Could not read Valorant: ${e.message}` };
        }
        return { success: false, message: 'Play this account with Valorant selected to read its rank and store, or add a HenrikDev key in Settings for ranks.' };
    });

    ipcMain.handle('valorant-loadout', async (event, username) => {
        if (locked()) return LOCKED;
        const acc = findAccount(username);
        if (!acc) return { success: false, message: 'Account not found' };
        // Fresh from the game when this account is signed in.
        await valorant.captureForAccount(acc.username).catch(() => false);
        const c = await valorant.getContent();
        const rec = valorant.getRecord(acc.username);
        if (!rec?.owned) return { success: false, message: 'Play this account with Valorant selected once, so the app knows its skins.' };
        const ctx = await valorant.signedInContext().catch(() => null);
        return {
            success: true,
            weapons: valorant.loadoutView(rec, c),
            canEquip: !!ctx && ctx.username.toLowerCase() === acc.username.toLowerCase(),
        };
    });

    ipcMain.handle('valorant-equip', async (event, { username, guns } = {}) => {
        if (locked()) return LOCKED;
        const acc = findAccount(username);
        if (!acc || !guns || typeof guns !== 'object') return { success: false, message: 'Account not found' };
        try {
            return await valorant.equip(acc.username, guns);
        } catch (e) {
            return { success: false, message: `Valorant did not take the loadout: ${e.response?.status || e.message}` };
        }
    });

    ipcMain.handle('valorant-save-set', (event, { username, set } = {}) => {
        if (locked()) return LOCKED;
        const acc = findAccount(username);
        if (!acc || !set || typeof set !== 'object') return { success: false, message: 'Account not found' };
        return valorant.saveSet(acc.username, set);
    });

    ipcMain.handle('valorant-delete-set', (event, { username, id } = {}) => {
        if (locked()) return LOCKED;
        const acc = findAccount(username);
        if (!acc || typeof id !== 'string') return { success: false, message: 'Account not found' };
        return valorant.deleteSet(acc.username, id);
    });

    ipcMain.handle('set-henrik-key', (event, key) => {
        const secrets = require('../services/secrets');
        const prev = state.config.henrikKeyEnc;
        const res = secrets.setHenrikKey(state.config, key);
        if (!res.success) return res;
        try {
            require('../services/storage').saveConfig();
        } catch (e) {
            if (prev === undefined) delete state.config.henrikKeyEnc; else state.config.henrikKeyEnc = prev;
            secrets.loadHenrikKey(state.config);
            return { success: false, message: `Could not save the key: ${e.message}` };
        }
        return { success: true };
    });

    if (state.config.valorantAutoSets) valorant.startAgentWatch();
}

module.exports = { register, summaryFor, viewFor };
