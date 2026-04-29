const accounts       = require('./accounts');
const launch         = require('./launch');
const stats          = require('./stats');
const overlayHandlers = require('./overlay-handlers');
const clientControls = require('./client-controls');
const config         = require('./config');
const updater        = require('./updater');

function registerAll() {
    accounts.register();
    launch.register();
    stats.register();
    overlayHandlers.register();
    clientControls.register();
    config.register();
    updater.register();
}

module.exports = { registerAll };
