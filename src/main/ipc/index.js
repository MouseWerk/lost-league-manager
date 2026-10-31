const accounts       = require('./accounts');
const launch         = require('./launch');
const stats          = require('./stats');
const overlayHandlers = require('./overlay-handlers');
const clientControls = require('./client-controls');
const config         = require('./config');
const updater        = require('./updater');
const lolData        = require('./lol-data');
const lobbyCheck     = require('./lobby-check');
const champBuild     = require('./champ-build');

function registerAll() {
    accounts.register();
    launch.register();
    stats.register();
    overlayHandlers.register();
    clientControls.register();
    config.register();
    updater.register();
    lolData.register();
    lobbyCheck.register();
    champBuild.register();
}

module.exports = { registerAll };
