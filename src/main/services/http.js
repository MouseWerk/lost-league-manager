// axios, loaded on the first request instead of at start-up: requiring it
// (with form-data and friends) took about 180 ms before the window could open.
// Callers use it like axios itself: http(config), http.get(...), http.post(...).

let real = null;
const load = () => real || (real = require('axios'));

function http(...args) {
    return load()(...args);
}

for (const method of ['request', 'get', 'post', 'put', 'patch', 'delete', 'head']) {
    http[method] = (...args) => load()[method](...args);
}
http.isAxiosError = (e) => load().isAxiosError(e);

module.exports = http;
