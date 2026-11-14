# Lost League Manager — Rust build

A Rust rewrite of the app. Tauri replaces the Electron main process; the
frontend in `../src/renderer/` is **unchanged and shared** — `app/src/bridge.js`
is injected before any page script and rebuilds the `window.electronAPI`
surface on top of Tauri commands and events. The same HTML/CSS/JS still runs
under Electron, so both builds work off one UI.

```
rust/
  core/   llm-core — all the domain logic, no windows and no Tauri. `cargo test` runs it alone.
  app/    llm-app  — the desktop shell: window, tray, commands, background workers.
```

## Running it

```bash
cd rust
cargo run -p llm-app      # the app
cargo test                # 126 tests
cargo clippy --all-targets
```

From the repo root, the end-to-end suite drives the real UI over the DevTools
protocol and runs against either runtime:

```bash
npm run test:e2e:rust     # this build
npm run test:e2e          # the Electron build
```

Both currently pass 29/29 — the same assertions against the same frontend, so a
difference between them is a real difference in the backend behind it.

## Your data carries over

The data directory is deliberately the same one Electron used
(`%APPDATA%\leaguelogin` — Electron derives it from package.json's `name`, not
the display name), so accounts, config, rank history and build paths are picked
up as-is.

Stored passwords are the delicate part: they're encrypted with a machine-bound
key (scrypt + AES-256-CBC). `core/tests/node_compat.rs` shells out to the Node
build's own `encryption.js` and checks both directions on the machine running
the tests, so an upgrade can't silently orphan a vault — and you can go back to
the Electron build without re-entering anything.

`LLM_DATA_DIR` overrides the directory; the E2E suite uses it to keep real data
out of the way.

## What is not in this build

- **Overwolf's game-events provider and its injected overlay.** Electron-only,
  no Rust equivalent. The build reminder doesn't need it — it reads Riot's own
  Live Client Data API and draws its own always-on-top popup. The cost is that
  nothing can draw over *exclusive* fullscreen; borderless is fine.
  `src/renderer/overlay.*` is unused here.
- **Installing updates in place.** The app does check GitHub for a newer
  release, says so with a notification, and opens the releases page — but it
  does not replace itself. Doing that needs Tauri's updater, which wants a
  signing keypair and a feed carrying Tauri artifacts; the existing releases
  hold Electron builds, and offering those to this build would be worse than
  saying nothing. Wiring it up is a release-pipeline decision: generate keys
  with `cargo tauri signer generate`, publish `latest.json`, then add the
  `updater` config and plugin.

Everything else is ported and covered by tests: accounts and the vault, config,
the launcher (still driving `resources/scripts/login.ps1`, password over stdin),
the LCU connection with auto-accept, queue-pop toast, champ-select events,
appear-offline and random skin, the honor-drop watchdog, Discord Rich Presence,
Data Dragon, ranked stats and match history from the Riot API, rank history, the
item shop with gold efficiency, build paths with OP.GG import, the in-game buy
reminder, client language switching, the tray, the taskbar jump list,
launch-at-login, and single-instance behaviour.

## Notes on two Windows-specific pieces

**The jump list** (`app/src/jumplist.rs`) is the only `unsafe` in the codebase.
Windows exposes it solely through COM, so building it means
`ICustomDestinationList` + `IShellLinkW` + a property store for each label.
Every call is checked and any failure is logged and swallowed — a missing jump
list is cosmetic, never a reason to fail a save.

**Launch-at-login** is the `HKCU\...\CurrentVersion\Run` key, which the user can
also change from outside the app, so `get_config` reads the real registry state
rather than trusting what was last saved.

## Packaging

```bash
cd rust/app
cargo tauri build         # release binary + NSIS installer
```

`app/tauri.conf.json` carries the NSIS target, the icon and the `login.ps1`
resource. The installer lands in `rust/target/release/bundle/nsis/`.
