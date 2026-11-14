// End-to-end test: launches the real app and drives the real renderer.
//
//   npm run test:e2e
//
// No test framework and no extra dependencies — the app is started as a child
// process with Chrome's remote debugging port open, and this script talks the
// DevTools protocol to it over `ws` (already a dependency). Everything it
// asserts goes through the actual UI and the actual IPC/main-process code:
// clicking the nav, filtering the item shop, building a plan, firing the popup.
//
// It runs against a throwaway --user-data-dir, so your real accounts, config
// and build paths are never touched (and Electron's single-instance lock keys
// off that directory, so your dev instance can keep running alongside it).
//
// Needs a network connection: the app pulls champion and item data from Data
// Dragon on boot, and the OP.GG import test scrapes op.gg.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 9333;
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-e2e-'));

// The same suite runs against either runtime: the Rust/Tauri build and the
// Electron one serve the same frontend, so anything that passes on one and
// fails on the other is a real difference in the backend behind it.
//   npm run test:e2e        -> Electron
//   npm run test:e2e:rust   -> Rust
const TARGET = process.env.LLM_E2E_TARGET === 'rust' ? 'rust' : 'electron';

const RUNTIME = {
    electron: {
        bin: path.join(ROOT, 'node_modules', '@overwolf', 'ow-electron', 'dist', 'electron.exe'),
        args: ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`],
        env: {},
        // Electron serves the page from a file:// URL.
        isMainPage: (t) => t.url.includes('index.html'),
        missing: 'ow-electron not found - run npm install first',
    },
    rust: {
        bin: path.join(ROOT, 'rust', 'target', 'debug', 'llm-app.exe'),
        args: [],
        // WebView2 takes its debug port from this variable, and the data
        // directory is redirected so the suite never touches real accounts.
        env: {
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
            LLM_DATA_DIR: USER_DATA,
        },
        // Tauri serves the page from its own protocol host.
        isMainPage: (t) => t.url.includes('tauri.localhost'),
        missing: 'llm-app.exe not found - run `cargo build -p llm-app` in rust/',
    },
}[TARGET];

const results = [];
let child = null;
let ws = null;
let msgId = 0;
const pending = new Map();

// ── tiny assertion helpers ───────────────────────────────────────────────────
function check(label, ok, detail) {
    results.push({ label, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? `\n        → ${detail}` : ''}`);
}
function checkEq(label, actual, expected) {
    check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── CDP plumbing ─────────────────────────────────────────────────────────────
function httpJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function waitForTarget(match, timeoutMs = 60000, label = 'target') {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
            const hit = targets.find(t => t.type === 'page' && match(t));
            if (hit) return hit;
        } catch { /* debugger not up yet */ }
        await sleep(300);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

// Anything the renderer throws or logs as an error, so a failing step can say
// why instead of just "timed out".
const rendererErrors = [];

function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl);
        socket.on('open', () => resolve(socket));
        socket.on('error', reject);
        socket.on('message', (raw) => {
            const msg = JSON.parse(raw);
            if (msg.method === 'Runtime.exceptionThrown') {
                const d = msg.params?.exceptionDetails;
                rendererErrors.push(d?.exception?.description || d?.text || 'unknown exception');
                return;
            }
            if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
                rendererErrors.push((msg.params.args || []).map(a => a.value ?? a.description).join(' '));
                return;
            }
            const handler = pending.get(msg.id);
            if (!handler) return;
            pending.delete(msg.id);
            if (msg.error) handler.reject(new Error(msg.error.message));
            else handler.resolve(msg.result);
        });
    });
}

function cdpOn(socket, method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); }
        }, 45000);
    });
}
function cdp(method, params = {}) {
    return cdpOn(ws, method, params);
}

// Evaluates an expression in the renderer and returns its value. Top-level
// await works — the expression is wrapped in an async IIFE.
async function evalJs(expression) {
    const res = await cdp('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
    });
    if (res.exceptionDetails) {
        throw new Error(`renderer: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    return res.result.value;
}

// Clicks, then checks the click had an effect, and retries if it didn't. The
// app wires its listeners in DOMContentLoaded while the markup it binds to is
// static, so an early click can land on a button that isn't live yet.
async function clickUntil(clickExpr, conditionExpr, label, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await evalJs(`${clickExpr}`);
        await sleep(150);
        if (await evalJs(`return (${conditionExpr});`)) return;
        await sleep(250);
    }
    const why = rendererErrors.length ? ` | renderer errors: ${rendererErrors.slice(-3).join(' ;; ')}` : '';
    throw new Error(`Clicked but never got: ${label}${why}`);
}

// Polls an expression in the renderer until it returns truthy.
async function waitFor(expression, timeoutMs = 30000, label = expression) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await evalJs(`return (${expression});`);
        if (last) return last;
        await sleep(250);
    }
    const why = rendererErrors.length ? ` | renderer errors: ${rendererErrors.slice(-3).join(' ;; ')}` : '';
    throw new Error(`Timed out waiting for: ${label} (last value ${JSON.stringify(last)})${why}`);
}

// ── the test ─────────────────────────────────────────────────────────────────
async function run() {
    if (!fs.existsSync(RUNTIME.bin)) {
        throw new Error(`${RUNTIME.missing} (looked in ${RUNTIME.bin})`);
    }

    console.log(`Launching the ${TARGET} build (data dir: ${USER_DATA})
`);
    child = spawn(RUNTIME.bin, RUNTIME.args, {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...RUNTIME.env },
    });
    const appLog = [];
    child.stdout.on('data', (d) => appLog.push(String(d)));
    child.stderr.on('data', (d) => appLog.push(String(d)));

    const target = await waitForTarget(RUNTIME.isMainPage, 60000, 'the main window');
    ws = await connect(target.webSocketDebuggerUrl);
    await cdp('Runtime.enable');

    // ── boot ─────────────────────────────────────────────────────────────────
    await waitFor(`document.querySelectorAll('.nav-btn').length > 0`, 30000, 'the app shell');
    check('app window loads its shell', true);

    const navViews = await evalJs(
        `return [...document.querySelectorAll('.nav-btn')].map(b => b.dataset.view);`);
    check('Build Paths has a nav entry', navViews.includes('buildsView'), JSON.stringify(navViews));

    // Data Dragon is fetched on boot; everything below needs it.
    const itemCount = await waitFor(
        `(await window.electronAPI.getItemList()).length`, 45000, 'item data from Data Dragon');
    check('item data loaded', itemCount > 100, `${itemCount} items`);

    // ── item shop ────────────────────────────────────────────────────────────
    await clickUntil(
        `document.querySelector('.nav-btn[data-view="statsView"]').click();`,
        `document.getElementById('statsView').classList.contains('active')`,
        'the Stat Viewer to open');
    await clickUntil(
        `document.querySelector('.stats-tab[data-stats-tab="itemsStatsTab"]').click();`,
        `document.getElementById('itemsStatsTab').classList.contains('active')`,
        'the Items tab to open');
    await waitFor(`document.querySelectorAll('#statsItemGrid .shop-item').length > 0`, 20000, 'the item grid');

    const total = await evalJs(`return document.querySelectorAll('#statsItemGrid .shop-item').length;`);
    const shown = await evalJs(`return Number(document.getElementById('statsItemCount').textContent);`);
    checkEq('grid count matches the item counter', shown, total);
    check('shop rail rendered its filters',
        (await evalJs(`return document.querySelectorAll('#shopRail .shop-cat-chip').length;`)) >= 15);
    check('tiles show a gold cost',
        (await evalJs(`return document.querySelectorAll('#statsItemGrid .shop-item-cost').length;`)) === total);

    // Category filter narrows, and every survivor really is an AP item.
    await evalJs(`document.querySelector('#shopRail .shop-cat-chip[data-cat="Ability Power"]').click();`);
    const apCount = await evalJs(`return document.querySelectorAll('#statsItemGrid .shop-item').length;`);
    check('category filter narrows the grid', apCount > 0 && apCount < total, `${apCount} of ${total}`);
    const allAp = await evalJs(`
        const ids = [...document.querySelectorAll('#statsItemGrid .shop-item')].map(e => Number(e.dataset.id));
        const items = await window.electronAPI.getItemList();
        return ids.every(id => items.find(i => i.id === id)?.tags.includes('SpellDamage'));
    `);
    check('every item left carries the Ability Power tag', allAp === true);

    // Tier filter stacks with it (AND, like the shop's checkboxes).
    await evalJs(`document.querySelector('#shopRail .shop-tier-chip[data-tier="legendary"]').click();`);
    const apLegendary = await evalJs(`return document.querySelectorAll('#statsItemGrid .shop-item').length;`);
    check('tier filter stacks with the category', apLegendary > 0 && apLegendary <= apCount,
        `${apLegendary} legendary AP of ${apCount} AP`);

    // Sorting.
    await evalJs(`
        const sel = document.getElementById('shopSortSelect');
        sel.value = 'cost-desc';
        sel.dispatchEvent(new Event('change'));
    `);
    const descOrdered = await evalJs(`
        const ids = [...document.querySelectorAll('#statsItemGrid .shop-item')].map(e => Number(e.dataset.id));
        const items = await window.electronAPI.getItemList();
        const costs = ids.map(id => items.find(i => i.id === id).gold.total);
        return costs.every((c, i) => i === 0 || costs[i - 1] >= c);
    `);
    check('cost-descending sort actually sorts', descOrdered === true);

    // Clearing puts everything back.
    await evalJs(`document.getElementById('shopClearBtn').click();`);
    checkEq('clear filters restores the full list',
        await evalJs(`return document.querySelectorAll('#statsItemGrid .shop-item').length;`), total);

    // Search + detail panel.
    await evalJs(`
        const s = document.getElementById('statsItemSearch');
        s.value = 'boots';
        s.dispatchEvent(new Event('input'));
    `);
    const bootsHits = await evalJs(`return document.querySelectorAll('#statsItemGrid .shop-item').length;`);
    check('search narrows to matching items', bootsHits > 0 && bootsHits < total, `${bootsHits} hits for "boots"`);

    await evalJs(`document.querySelector('#statsItemGrid .shop-item').click();`);
    const detailText = await waitFor(
        `document.getElementById('statsItemDetail').innerText.includes('%') &&
         document.getElementById('statsItemDetail').innerText`,
        10000, 'the item detail panel');
    check('clicking a tile opens its gold-efficiency detail',
        /boots/i.test(detailText), detailText.slice(0, 120));
    check('selected tile is marked',
        (await evalJs(`return document.querySelectorAll('#statsItemGrid .shop-item.selected').length;`)) === 1);

    // ── build paths ──────────────────────────────────────────────────────────
    await clickUntil(
        `document.querySelector('.nav-btn[data-view="buildsView"]').click();`,
        `document.getElementById('buildsView').classList.contains('active')`,
        'Build Paths to open');
    await waitFor(`document.querySelectorAll('#bpChampGrid .stats-grid-item').length > 0`, 20000, 'the champion grid');

    await evalJs(`
        const s = document.getElementById('bpChampSearch');
        s.value = 'Ahri';
        s.dispatchEvent(new Event('input'));
    `);
    await waitFor(`document.querySelectorAll('#bpChampGrid .stats-grid-item').length === 1`, 5000, 'the Ahri tile');
    await evalJs(`document.querySelector('#bpChampGrid .stats-grid-item').click();`);
    await waitFor(`document.querySelector('.bp-target-name')?.textContent === 'Ahri'`, 10000, 'the Ahri editor');
    check('champion editor opens', true);

    // Add a step by hand: Add step → picker → pick Dark Seal.
    await evalJs(`document.getElementById('bpAddStepBtn').click();`);
    await waitFor(`!!document.getElementById('bpItemSearch')`, 5000, 'the item picker');
    await evalJs(`
        const s = document.getElementById('bpItemSearch');
        s.value = 'Dark Seal';
        s.dispatchEvent(new Event('input'));
    `);
    await waitFor(`document.querySelectorAll('#bpPickerList .bp-picker-item').length > 0`, 5000, 'picker results');
    await evalJs(`document.querySelector('#bpPickerList .bp-picker-item').click();`);
    await waitFor(`document.querySelectorAll('.bp-step').length === 1`, 5000, 'the new step');

    const stepGold = await evalJs(`return Number(document.querySelector('.bp-gold-input').value);`);
    checkEq('threshold auto-fills to the item cost', stepGold, 350);
    const chipName = await evalJs(`return document.querySelector('.bp-item-name').textContent;`);
    checkEq('the picked item is on the step', chipName, 'Dark Seal');

    // The autosave debounce is 400ms; give it room, then read it back through IPC.
    await sleep(1200);
    const saved = await evalJs(`
        const res = await window.electronAPI.getBuildPaths();
        return res.paths.Ahri ? JSON.stringify(res.paths.Ahri.steps) : null;
    `);
    check('plan persisted to disk through the main process',
        !!saved && JSON.parse(saved)[0].gold === 350, saved);
    check('the plan is what would fire in game',
        (await evalJs(`
            const p = await window.electronAPI.resolveBuildPath('Ahri');
            return p && p.steps[0].items[0].name;
        `)) === 'Dark Seal');

    // A champion with no plan resolves to nothing.
    check('a champion with no plan resolves to null',
        (await evalJs(`return await window.electronAPI.resolveBuildPath('Teemo');`)) === null);

    // ── OP.GG import ─────────────────────────────────────────────────────────
    const imported = await evalJs(`return await window.electronAPI.importBuildPath('Ahri', 'MIDDLE');`);
    if (imported?.success) {
        check('OP.GG import returns steps', imported.steps.length >= 2, JSON.stringify(imported.steps));
        check('every imported step has a positive threshold',
            imported.steps.every(s => s.gold > 0), JSON.stringify(imported.steps.map(s => s.gold)));
        check('the opening buy is affordable (<= 1000g)',
            imported.steps[0].gold <= 1000, `${imported.steps[0].gold}g`);
        const ids = imported.steps.flatMap(s => s.items);
        check('no item is imported twice', new Set(ids).size === ids.length, JSON.stringify(ids));
    } else {
        console.log(`SKIP  OP.GG import (${imported?.message}) — network or site layout`);
    }

    // ── the in-game popup ────────────────────────────────────────────────────
    const preview = await evalJs(`return await window.electronAPI.previewBuildReminder();`);
    check('preview reports success', preview?.success === true, JSON.stringify(preview));

    const popup = await waitForTarget(t => t.url.includes('reminder.html'), 15000, 'the popup window');
    check('the popup window actually opens', !!popup);

    const popupWs = await connect(popup.webSocketDebuggerUrl);
    // textContent, not innerText: the popup auto-hides after a few seconds and
    // innerText is empty for anything not being rendered. Poll rather than
    // sample once — the window can be up a beat before its payload arrives.
    let popupText = '';
    const popupDeadline = Date.now() + 10000;
    while (Date.now() < popupDeadline) {
        const res = await cdpOn(popupWs, 'Runtime.evaluate', {
            expression: 'document.body.textContent',
            returnByValue: true,
        });
        popupText = res.result.value || '';
        if (/Dark Seal/i.test(popupText)) break;
        await sleep(250);
    }
    check('the popup renders the items to buy',
        /Dark Seal/i.test(popupText) && /BUY NOW/i.test(popupText), JSON.stringify(popupText));
    popupWs.close();

    // ── settings round-trip ──────────────────────────────────────────────────
    await clickUntil(
        `document.querySelector('.nav-btn[data-view="settingsView"]').click();`,
        `document.getElementById('settingsView').classList.contains('active')`,
        'Settings to open');
    await evalJs(`
        const t = document.getElementById('buildRemindersEnabledToggle');
        t.checked = false;
        t.dispatchEvent(new Event('change'));
    `);
    await sleep(400);
    checkEq('reminder toggle persists to config',
        await evalJs(`return (await window.electronAPI.getConfig()).buildRemindersEnabled;`), false);
    await evalJs(`
        const t = document.getElementById('buildRemindersEnabledToggle');
        t.checked = true;
        t.dispatchEvent(new Event('change'));
    `);

    // ── no renderer errors along the way ─────────────────────────────────────
    check('no uncaught renderer errors', rendererErrors.length === 0,
        rendererErrors.slice(0, 3).join(' | '));
    void appLog;
}

// ── teardown ─────────────────────────────────────────────────────────────────
function cleanup() {
    try { ws?.close(); } catch { /* already gone */ }
    if (child && !child.killed) {
        try {
            if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
            else child.kill('SIGKILL');
        } catch { /* already gone */ }
    }
    try { fs.rmSync(USER_DATA, { recursive: true, force: true, maxRetries: 3 }); } catch { /* locked; temp dir */ }
}

run()
    .then(() => {
        const failed = results.filter(r => !r.ok).length;
        console.log(`\n${results.length - failed}/${results.length} checks passed`);
        cleanup();
        setTimeout(() => process.exit(failed === 0 ? 0 : 1), 500);
    })
    .catch((err) => {
        console.error(`\nE2E ERROR: ${err.message}`);
        const failed = results.filter(r => !r.ok).length;
        console.log(`${results.length - failed}/${results.length} checks passed before the error`);
        cleanup();
        setTimeout(() => process.exit(2), 500);
    });
