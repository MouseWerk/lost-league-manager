const { ipcMain } = require('electron');
const championData = require('../services/champion-data');
const itemData = require('../services/item-data');

function register() {
    ipcMain.handle('get-champion-full-data', async (event, champKey) => {
        await championData.whenReady();
        return championData.getChampionFullData(champKey);
    });

    ipcMain.handle('get-item-list', async () => {
        await itemData.whenReady();
        return itemData.getItemList();
    });
}

module.exports = { register };
