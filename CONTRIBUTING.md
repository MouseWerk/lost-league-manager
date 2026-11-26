# Contributing

Thanks for helping with Lost League Manager!

## Before you start

- **Bugs and ideas:** open an issue with the bug report or feature request form, or talk about it on
  [Discord](https://discord.gg/ZyfUMWTPFe) first.
- **Security problems:** report them privately, see [SECURITY.md](SECURITY.md).
- **Bigger changes:** open an issue first, so we can agree on the approach before you put in the work.

## Setup

You need Windows and Node.js 22 or newer.

```bash
git clone https://github.com/MouseWerk/lost-league-manager.git
cd lost-league-manager
npm install
npm start        # run the app
npm test         # unit and guard tests
```

## Pull requests

- Branch off `master` and keep one change per pull request.
- Run `npm test`; every test must pass. Add a test for new logic where you can.
- Describe what changed and how you tested it in the app (League or Valorant, which screens).
- Never commit logins, `accounts.json`, `config.json` or other personal data.

Releases are built by the maintainers: a `v*` tag runs the release workflow.
