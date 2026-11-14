const { ipcMain } = require('electron');
const buildPaths = require('../services/build-paths');
const buildReminder = require('../services/build-reminder');

function register() {
    // ── Editor (main window) ──────────────────────────────────────────────────
    ipcMain.handle('get-build-paths', () => ({
        paths:  buildPaths.getAll(),
        limits: { maxSteps: buildPaths.MAX_STEPS, maxItemsPerStep: buildPaths.MAX_ITEMS_PER_STEP },
    }));

    ipcMain.handle('save-build-path', (event, { champKey, steps } = {}) =>
        buildPaths.setPath(champKey, steps));

    ipcMain.handle('delete-build-path', (event, champKey) =>
        buildPaths.deletePath(champKey));

    // Replaces the champion's plan with OP.GG's recommended build for that role.
    ipcMain.handle('import-build-path', (event, { champKey, position } = {}) =>
        buildPaths.importFromOpgg(champKey, position));

    // ── Overlay / popup ───────────────────────────────────────────────────────
    ipcMain.handle('resolve-build-path', (event, champKey) =>
        buildPaths.resolveForChampion(champKey));

    ipcMain.on('build-reminder-skip', (event, index) => {
        if (Number.isInteger(index)) buildReminder.skipStep(index);
    });

    // Fires a sample popup from Settings. The real one only ever appears
    // mid-match, so without this there's no way to check it shows up over your
    // game (or where on screen it lands) short of queueing up.
    ipcMain.handle('preview-build-reminder', () => {
        const itemData = require('../services/item-data');
        const sample = [1001, 1082].map(id => ({
            id,
            name: itemData.getItemMeta(id)?.name || `Item ${id}`,
            cost: itemData.getItemCost(id),
        }));
        const gold = sample.reduce((sum, i) => sum + i.cost, 0) || 650;
        try {
            require('../windows').showBuyReminder({
                index: 0, totalSteps: 3, gold, currentGold: gold + 12,
                champKey: null, items: sample,
            });
            return { success: true };
        } catch (e) {
            return { success: false, message: e.message };
        }
    });
}

module.exports = { register };
