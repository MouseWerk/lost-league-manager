# Security policy

Lost League Manager stores Riot logins on your PC, so security reports matter a lot to us.

## Supported versions

Only the [latest release](https://github.com/MouseWerk/lost-league-manager/releases/latest) gets
fixes. The app updates itself, so please check you are on it before reporting.

## Reporting a vulnerability

Please **do not** open a public issue or post it on Discord.

Report it privately on GitHub instead:
**[Security → Report a vulnerability](https://github.com/MouseWerk/lost-league-manager/security/advisories/new)**.

Helpful to include:

- the app version (Settings shows it),
- what an attacker can do and what they need for it (local access, a crafted file, network position…),
- steps to reproduce, or a proof of concept.

You get an answer within a few days. Once a fix is released, the advisory is published and you are
credited, unless you prefer not to be.

## In scope

- Stored logins or passwords leaving the PC, or being readable by other users or apps.
- The updater installing something that is not an official release.
- Code running from data the app reads (League or Riot Client APIs, Discord, files it imports).

Out of scope: problems in League of Legends, Valorant, the Riot Client or Overwolf themselves, and
anything that needs an attacker who already controls your Windows account.
