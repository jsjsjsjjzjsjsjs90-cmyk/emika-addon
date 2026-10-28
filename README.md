# Emika Addon

A playback-only [BitChord](https://bitcord.app) addon. Exposes a `manifest.json`,
a `/search` endpoint, and a `/stream/:id` endpoint that returns a directly
playable HTTPS rendition. No downloads, no accounts, no persistent storage.

Written in TypeScript, runs on Node 20+ / Vercel Serverless / any Node host.

---

## What it does

BitChord sends a query, the addon races one or more upstream providers, and
returns the first set of usable tracks. When the user taps play, BitChord asks
for `/stream/:id`, and the addon resolves that track through the same upstream
and hands back a playable URL.

Upstream URLs never leak to BitChord. IDs returned from `/search` are HMAC-signed
and encode the source name, so a `/stream` request can never be redirected to a
provider the track didn't come from.

---

## Sources

The addon supports six upstream adapters. Which ones are live is controlled by
`QOBUZ_ENABLED_SOURCES`.

| Name | Adapter | Status |
|---|---|---|
| `qobuzdl` | [Qobuz-DL Worker](https://qobuz-dll.foreyou.workers.dev) | Working — search + stream |
| `instable` | [Instable](https://instable.arcod.xyz) | Working — search + stream |
| `lastbabe` | LastBabe (mint-on-demand) | Implemented, disabled by default |
| `monochrome` | Monochrome | Implemented, disabled by default |
| `deezer` | Remote addon proxy | Implemented, disabled by default |
| `eljohnzc` | — | Not implemented (returns empty) |

When multiple sources are enabled, `/search` races them and resolves with the
first non-empty result. Each source has its own timeout (`SOURCE_SEARCH_TIMEOUT_MS`)
so a hung provider cannot block the whole request.

---

## HTTP contract

### `GET /manifest.json`

Returns the BitChord capability manifest.

```json
{
  "id": "com.bitchord.qobuz",
  "name": "Emika addon",
  "version": "1.0.0",
  "resources": ["search", "stream"],
  "allowDownloads": 0,
  "checkValidLossless": 0
}
