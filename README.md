# Mokson's bb plugins

A personal [bb](https://github.com/get-bb/bb) plugin marketplace.

## Add the marketplace

```sh
bb marketplace add git:https://github.com/Mokson/bb-plugins
```

Adding a marketplace installs nothing — it only makes these plugins discoverable
under **Extensions → Plugins**, in `bb plugin search`, and installable by id.

## Plugins

| Plugin | What it does |
| --- | --- |
| [`better-sidebar`](plugins/better-sidebar) | A sidebar thread list organised by activity date, with a second metadata row, real provider logos, five minimal status glyphs, a PR chip, and a hover dossier. |
| [`push-notify`](plugins/push-notify) | Web Push notifications when an agent finishes, fails, or needs you, filtered by subagent threads, turn length, and muted projects. |

Install one directly, without the marketplace:

```sh
bb plugin install git:https://github.com/Mokson/bb-plugins \
  --subdirectory plugins/better-sidebar
```

## Layout

- `marketplace.json` — the catalog bb reads. Hand-maintained; one entry per plugin
  in `plugins[]`.
- `plugins/<id>/` — one self-contained plugin package per directory. Each has its
  own `package.json`, tests, and release tags.

## Releasing

Each plugin is tagged independently, so `marketplace.json` ranges over its own
tags via `tagPrefix`:

```sh
git tag better-sidebar/v0.1.0
git push origin better-sidebar/v0.1.0

git tag push-notify/v0.1.0
git push origin push-notify/v0.1.0
```

A `range` entry resolves to the highest matching `<tagPrefix>vX.Y.Z` tag, so a
plugin with no release tag yet is listed but not installable.

## Licence

MIT. Each plugin carries its own `LICENSE`.
