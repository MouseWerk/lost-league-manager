<div align="center">
  <img src="src/renderer/assets/logo.png" alt="Lost League Manager" width="80" />
  <h1>Lost League Manager</h1>
  <p>Save your League of Legends logins once, then switch accounts in one click.</p>

  <a href="https://www.lostleague.com/">
    <img src="https://img.shields.io/badge/Website-lostleague.com-1F7F74?style=for-the-badge" alt="Official website">
  </a>
  <a href="https://github.com/MouseWerk/lost-league-manager/releases/latest">
    <img src="https://img.shields.io/github/v/release/MouseWerk/lost-league-manager?style=for-the-badge&color=1F7F74&label=Download" alt="Latest release">
  </a>
  <a href="https://github.com/MouseWerk/lost-league-manager/releases">
    <img src="https://img.shields.io/github/downloads/MouseWerk/lost-league-manager/total?style=for-the-badge&color=172234&label=Downloads" alt="Total downloads">
  </a>
  <a href="https://github.com/MouseWerk/lost-league-manager/actions/workflows/release.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/MouseWerk/lost-league-manager/release.yml?style=for-the-badge&label=Build" alt="Build status">
  </a>
  <img src="https://img.shields.io/badge/platform-Windows-172234?style=for-the-badge" alt="Windows">
  <br><br>
  <a href="https://www.buymeacoffee.com/mousewerk">
    <img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy me a coffee">
  </a>

  <br><br>
  <img src="docs/screenshot.png" alt="The account list with ranks, the selected account's panel and its goal rank" width="760" />
</div>

---

## What it does

### Accounts
- **One-click login.** Pick an account and press Play: the app closes the client, starts the Riot
  Client and signs in for you.
- **Quick add.** Type a Riot ID or paste an OP.GG link; rank, icon, server and label fill in. Or take
  the account that is signed into the client.
- **Ranks at a glance.** Every account shows its solo rank with the ranked emblem from the League
  client, LP and win rate. Ranks work without a Riot API key (League client, OP.GG, or the Riot API
  if you add a key).
- **Account panel.** Rank history, the last five games, notes, today's LP and games, and a goal
  rank with the LP still to go.
- **Find and sort.** Search by name or Riot ID, filter by server, sort by rank, name, server, or
  last played, or drag accounts into your own order.
- **Safe storage.** Passwords are encrypted on your PC. An optional vault password locks the app,
  and backups are protected with a password you choose.

### While you play
- **Live view.** Your rank, champion mastery and recent games from the running client.
- **Lobby check.** The ranks of your party, of your champion select where the game shows names,
  and of all ten players once the game starts, with one click to OP.GG multi-search. Ranked
  champion select keeps names hidden, as the game does.
- **Auto-accept**, a random owned skin in champion select, appear offline, dodge, and a
  notification when a match is found.

### Stat viewer and tools
- **Champion stats** at any level from Riot's data, including the exact attack speed growth.
- **Item gold value.** What an item's stats are worth in gold, ability haste and penetration
  included.
- **Tools.** Close every Riot process, repair a client that will not start, clear the Riot Client
  cache, change the client language.

### The app
- Light and dark themes, or follow Windows. Interface size from 75% to 150%.
- A short setup on first start, automatic updates, tray menu and Windows jump list.

<div align="center">
  <img src="docs/screenshot2.png" alt="Live view with the ranks of both teams" width="380" />
  <img src="docs/screenshot-light.png" alt="The account list in the light theme" width="380" />
</div>

---

## Install

1. Download `Lost-League-Manager-Setup.exe` from the
   **[latest release](https://github.com/MouseWerk/lost-league-manager/releases/latest)**.
2. Run the installer and start **Lost League Manager**.
3. The setup checks your League install and adds your first account.

> **Windows SmartScreen warning?** Right-click the installer, choose Properties, tick **Unblock**,
> click Apply and run it again. The app is not code-signed; the source is all here.

> **During the login** the app types your login name and password into the Riot Client. Leave
> mouse and keyboard alone for those few seconds.

---

## Build from source

```bash
git clone https://github.com/MouseWerk/lost-league-manager.git
cd lost-league-manager
npm install
npm start        # run the app
npm test         # unit and guard tests
npm run build    # build the installer
```

---

Lost League Manager is not endorsed by Riot Games and does not reflect the views or opinions of Riot
Games or anyone officially involved in producing or managing Riot Games properties. Riot Games and
all associated properties are trademarks or registered trademarks of Riot Games, Inc.
