const { ipcMain } = require('electron');
const lcu = require('../lcu');
const state = require('../state');
const opgg = require('../services/opgg-api');
const championData = require('../services/champion-data');
const clientImport = require('../services/client-import');

// Champ select build import: the OP.GG runes and items for the champion the
// player has picked (or is hovering), and putting them into the client.

const LCU_POSITIONS = { top: 'top', jungle: 'jungle', middle: 'mid', bottom: 'adc', utility: 'support' };

// The local player's champion (picked or hovered), position and whether the
// pick is locked in, from a champ select session. null outside champ select.
function pickFromSession(s) {
    if (!s || !Array.isArray(s.myTeam)) return null;
    const me = s.myTeam.find((m) => m.cellId === s.localPlayerCellId);
    const championId = me?.championId || me?.championPickIntent || 0;
    const actions = Array.isArray(s.actions) ? s.actions.flat() : [];
    return {
        championId,
        position: LCU_POSITIONS[String(me?.assignedPosition || '').toLowerCase()] || null,
        locked: !!championId && actions.some((a) => a.actorCellId === s.localPlayerCellId && a.type === 'pick' && a.completed && a.championId === championId),
    };
}

// The same, plus the game mode (ARAM has its own builds).
async function currentPick(session) {
    const pick = pickFromSession(session || await lcu.request('GET', '/lol-champ-select/v1/session'));
    if (!pick?.championId) return pick;
    const flow = await lcu.request('GET', '/lol-gameflow/v1/session');
    return { ...pick, mode: flow?.gameData?.queue?.gameMode === 'ARAM' ? 'aram' : 'ranked' };
}

function championInfo(championId) {
    const key = championData.getIdToNameMap()[championId] || null;
    const entry = key ? championData.getChampionList().find((c) => c.key === key) : null;
    return { key, name: entry?.name || key || '', icon: key ? championData.getIdToImageMap()[key] || null : null };
}

async function buildForPick(pick, position) {
    const champ = championInfo(pick.championId);
    if (!champ.key) throw new Error('Unknown champion');
    const pos = opgg.BUILD_POSITIONS.includes(position) ? position : pick.position;
    const build = await opgg.getChampionBuild(champ.key, pos, pick.mode);
    return { champ, build };
}

async function getChampBuild(position) {
    if (!lcu.connected) return { success: false, message: 'The League client is not running' };
    await championData.whenReady();
    const pick = await currentPick();
    if (!pick) return { success: false, message: 'Not in champion select' };
    if (!pick.championId) return { success: false, waiting: true, message: 'Pick or hover a champion first' };
    try {
        const { champ, build } = await buildForPick(pick, position);
        return { success: true, championId: pick.championId, champion: champ.name, icon: champ.icon, version: championData.getLatestVersion(), build };
    } catch (e) {
        return { success: false, message: e.message };
    }
}

async function importBuild({ what = 'both', position = null, replaceCurrent = false } = {}) {
    if (!lcu.connected) return { success: false, message: 'The League client is not running' };
    await championData.whenReady();
    const pick = await currentPick();
    if (!pick?.championId) return { success: false, message: 'Pick or hover a champion first' };
    let found;
    try {
        found = await buildForPick(pick, position);
    } catch (e) {
        return { success: false, message: e.message };
    }
    const out = { success: true };
    if (what === 'runes' || what === 'both') out.runes = await clientImport.importRunes(found.build, found.champ.name, { replaceCurrent: !!replaceCurrent });
    if (what === 'items' || what === 'both') out.items = await clientImport.importItemSet(found.build, found.champ.name, pick.championId);
    out.success = [out.runes, out.items].filter(Boolean).every((r) => r.success);
    return out;
}

// Automatic import once the player has locked a champion (Settings >
// Automation). Never replaces a page of the player's own: when all pages are
// taken, it only adds the item set and says so.
let importedFor = null;
async function autoImportOnLock(session) {
    if (!state.config.autoImportBuild) return null;
    // Champ select sends an update every second; only a new locked pick goes on.
    const quick = pickFromSession(session);
    if (!quick?.locked || importedFor === quick.championId) return null;
    importedFor = quick.championId;
    const pick = await currentPick(session);
    await championData.whenReady();
    try {
        const { champ, build } = await buildForPick(pick, null);
        const runes = await clientImport.importRunes(build, champ.name);
        const items = await clientImport.importItemSet(build, champ.name, pick.championId);
        return { champion: champ.name, runes, items };
    } catch (e) {
        return { champion: championInfo(pick.championId).name, error: e.message };
    }
}

function resetAutoImport() {
    importedFor = null;
}

function register() {
    ipcMain.handle('get-champ-build', (event, { position } = {}) => getChampBuild(position));
    ipcMain.handle('import-champ-build', (event, opts) => importBuild(opts && typeof opts === 'object' ? opts : {}));
}

module.exports = { register, pickFromSession, currentPick, getChampBuild, importBuild, autoImportOnLock, resetAutoImport, LCU_POSITIONS };
