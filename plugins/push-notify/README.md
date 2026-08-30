# bb plugin — Push Notify

Web Push notifications when a bb agent finishes, fails, or stops to ask you
something — even when bb is closed. Notifications are sent directly from your bb
server, with no polling or hosted backend.

Adapted from [MayankBansal12/bb-plugin-web-push-notify](https://github.com/MayankBansal12/bb-plugin-web-push-notify),
which does the delivery work this plugin builds on.

> This plugin uses a new plugin id (`push-notify`), so it gets its own database
> and its own VAPID keys: every device must subscribe again. Uninstall
> `web-push-notify` first, or both plugins will push for the same events.

## What it adds

- **Needs-you notifications** — a thread that goes idle with a question or an
  approval waiting sends its own high-urgency notification instead of the
  ordinary "finished" one, under its own tag so a later push cannot bury it.
  Per device.
- **Subagent filter** — threads spawned by another thread produce no finished or
  needs-you notification. Failures always notify. Global, on by default.
- **Minimum turn length** — a turn shorter than the configured number of seconds
  sends nothing. Unknown durations (a turn that started before the plugin
  loaded) still notify. Global, 30 seconds by default; 0 disables it.
- **Muted projects** — a muted project sends nothing at all, failures included.
  Global.

The three filters are server-wide; the per-device switches (enabled, finished,
failed, needs you, show details) stay on each device card.

## Install

Requires bb 0.36 or newer and an HTTPS or localhost bb origin.

```sh
bb plugin install git:https://github.com/Mokson/bb-plugins --subdirectory plugins/push-notify --yes
```

Open **Settings → Extensions → Plugins → Push Notify**, name the browser, then
allow notifications and select **Enable and test**.

## Security and backups

bb stores this plugin's VAPID private key and browser push subscriptions in the
plugin database under bb's data directory. Treat that database, its WAL files,
and backups as credentials: restrict host and backup access to the bb operator.
Anyone who obtains both the private key and subscription records can send
notifications that appear to come from this bb server.

Removing and reinstalling the plugin may rotate the VAPID key and require
browsers to register again. Restores should keep the plugin database and its WAL
files together.

## Develop

```sh
npm install
npm run typecheck
npm test
npm run build
bb plugin install . --yes
bb plugin dev
```
