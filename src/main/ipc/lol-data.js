const { ipcMain } = require('electron');
const championData = require('../services/champion-data');
const itemData = require('../services/item-data');

function register() {
    ipcMain.handle('get-champion-full-data', (event, champKey) => {
        return championData.getChampionFullData(champKey);
    });

    ipcMain.handle('get-item-list', () => {
        return itemData.getItemList();
    });
}

module.exports = { register };
