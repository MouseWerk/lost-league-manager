const { ipcMain } = require('electron');
const championData = require('../services/champion-data');
const itemData = require('../services/item-data');

function register() {
    ipcMain.handle('get-champion-full-data', async (event, champKey) => {
        await championData.whenReady();
        const data = championData.getChampionFullData(champKey);
        if (!data) return null;
        return { ...data, attackSpeedRatio: await championData.getAttackSpeedRatio(champKey) };
    });

    ipcMain.handle('get-item-list', async () => {
        await itemData.whenReady();
        return itemData.getItemList();
    });
}

module.exports = { register };
