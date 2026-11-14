// Runs the end-to-end suite against the Rust/Tauri build instead of Electron.
// A tiny wrapper so the npm script stays portable (no cross-env dependency).
process.env.LLM_E2E_TARGET = 'rust';
require('./e2e.js');
