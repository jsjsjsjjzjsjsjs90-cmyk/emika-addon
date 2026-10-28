```markdown
# Emika Addon

A playback-only [BitChord](https://bitcord.app) addon. Exposes a `manifest.json`, a `/search` endpoint, and a `/stream/:id` endpoint that returns a directly playable HTTPS rendition. No downloads, no accounts, no persistent storage.

TypeScript · Node 20+ · Vercel Serverless or any Node host.

---

## What it does

BitChord sends a query, the addon races one or more upstream providers, and returns the first set of usable tracks. When the user taps play, BitChord asks `/stream/:id`, and the addon resolves that track through the same upstream and hands back a playable URL.

Upstream URLs never leak to BitChord. IDs returned from `/search` are HMAC-signed and encode the source name, so a `/stream` request can never be redirected to a provider the track didn't come from.

---

## Sources

Six upstream adapters. Which ones are live is controlled by `QOBUZ_ENABLED_SOURCES`.

| Name | Adapter | Status |
|---|---|---|
| `qobuzdl` | Qobuz-DL Worker | Working — search + stream |
| `instable` | Instable | Working — search + stream |
| `lastbabe` | LastBabe (mint-on-demand) | Implemented, disabled by default |
| `monochrome` | Monochrome | Implemented, disabled by default |
| `deezer` | Remote addon proxy | Implemented, disabled by default |
| `eljohnzc` | — | Not implemented (returns empty) |

When multiple sources are enabled, `/search` races them and resolves with the first non-empty result. Each source has its own timeout (`SOURCE_SEARCH_TIMEOUT_MS`), so a hung provider cannot block the whole request.

---

## HTTP contract

### `GET /manifest.json`

```json
{
  "id": "com.bitchord.qobuz",
  "name": "Emika addon",
  "version": "1.0.0",
  "resources": ["search", "stream"],
  "allowDownloads": 0,
  "checkValidLossless": 0
}
```

GET /search?q=<query>&quality=<LOSSLESS|HIGH|LOW>&atmos=<auto|on|off>

```json
{ "tracks": [{ "id": "qobuz_<signed>", "title": "...", "artist": "...", "album": "...", "artworkURL": "https://...", "duration": 180 }] }
```

· All enabled sources down or empty → 200 with { "tracks": [] }
· All enabled sources throw → 502

GET /stream/:id?quality=<...>&atmos=<...>

```json
{ "url": "https://...", "format": "flac", "quality": "LOSSLESS", "manifest": "none" }
```

Returns 404 when:

· the signed ID is invalid or tampered
· the upstream has no stream for that track
· the stream is HTTP-only, encrypted, or malformed

GET /health

```json
{ "ok": true }
```

Suitable for a platform health check.

GET /health/sources?q=<optional test query>

Fan-out health check. Queries each enabled source with a real search.

Per-source status:

Status Meaning
healthy Returned at least one track
no_results Responded, empty
unhealthy Threw or timed out
disabled_by_config Not in QOBUZ_ENABLED_SOURCES
not_implemented No adapter exists (eljohnzc)

Top-level overallStatus: all_systems_operational · operational_with_minor_outages · degraded_but_functional · outage.

Isolated source routes

Each source has its own root, useful for testing one source inside BitChord's UI:

Prefix Source
/a qobuzdl
/b lastbabe
/c monochrome
/d deezer
/e eljohnzc
/f instable

Each exposes /manifest.json, /search, /stream/:id backed by a single provider.

---

Environment variables

Required in production

Name Purpose
QOBUZ_ID_SECRET HMAC key for signing track IDs

Generate:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The addon refuses to boot in production if this is missing. If you lose it, existing IDs become invalid — users re-search. That is preferable to the dev fallback, which lets anyone forge IDs.

Recommended

Name Default Purpose
QOBUZ_ENABLED_SOURCES qobuzdl,instable Comma-separated live sources
SOURCE_SEARCH_TIMEOUT_MS 3000 Per-source race timeout (ms)

Optional

Name Default Purpose
REQUEST_TIMEOUT_MS 6000 Whole-request ceiling
UPSTREAM_RETRIES 1 Retries on retryable upstream 5xx
CACHE_TTL_SECONDS 300 Search cache TTL
QOBUZ_PROVIDER multi multi \| qobuzdl \| http \| stub

Per-source URLs

All have working defaults. Set only if a hostname changes.

```
QOBUZ_UPSTREAM_BASE_URL=https://qobuz-dll.foreyou.workers.dev
LASTBABE_BASE_URL=https://lastbabe.velixir.run
MONOCHROME_BASE_URL=https://tracks.monochrome.st
DEEZER_BASE_URL=https://bitchord-hires-addon.vercel.app
INSTABLE_BASE_URL=https://instable.arcod.xyz
```

See .env.example for the complete list including Instable overrides.

---

Local development

```bash
cp .env.example .env
# Edit .env and set QOBUZ_ID_SECRET to any string for local testing.

npm install
npm run dev
```

```bash
curl http://localhost:3000/manifest.json
curl 'http://localhost:3000/search?q=kind+of+blue&quality=LOSSLESS&atmos=auto'
curl 'http://localhost:3000/health/sources'
```

Type-check:

```bash
npm run build
```

Tests:

```bash
npm test
```

---

Deploy to Vercel

1. Import the repo at vercel.com. Framework preset: Other. Build command and output directory: leave blank — vercel.json and api/index.ts handle it.
2. In Settings → Environment Variables, add these three for Production, Preview, and Development:
   ```
   QOBUZ_ID_SECRET          = <your generated 48-byte string>
   QOBUZ_ENABLED_SOURCES    = qobuzdl,instable
   SOURCE_SEARCH_TIMEOUT_MS = 3000
   ```
3. Deploy. Then verify:
   ```bash
   curl -sS -o /dev/null -w 'root:     %{http_code}\n' https://<your-deployment>/
   curl -sS -o /dev/null -w 'manifest: %{http_code}\n' https://<your-deployment>/manifest.json
   curl -sS 'https://<your-deployment>/health/sources' \
     | jq '{overallStatus, providers: [.providers[] | {source, status}]}'
   ```
   Expect 200 for both endpoints and all_systems_operational or degraded_but_functional.
4. In BitChord → Settings → Sources → Add an addon, paste https://<your-deployment> (no trailing slash). BitChord will request /manifest.json and register it as streaming-only.

---

Troubleshooting

500 on every route, logs say QOBUZ_ID_SECRET is required in production

Env var isn't set or wasn't applied to this deployment. Env vars only take effect on new builds — after adding, go to Deployments → ⋯ → Redeploy.

404 on /manifest.json but /health works

Route-joining is mis-registering prefixed routes. joinRoute() must trim trailing slashes from prefix before concatenation. If you replace server.ts, keep that helper.

/search takes 6 seconds and returns 502

One enabled source is hung and ignoring the per-source timeout. Confirm with /health/sources — the slow source shows unhealthy with Timeout. Either remove it from QOBUZ_ENABLED_SOURCES or raise SOURCE_SEARCH_TIMEOUT_MS (keep below REQUEST_TIMEOUT_MS).

/search returns {"tracks":[]} but /health/sources shows healthy

Health uses q=love; your real query differs. Try /health/sources?q=<your query> to reproduce with the same input. If that returns results but /search doesn't, check for a quality mismatch (some upstreams only support LOSSLESS).

/stream/:id returns 404 for a track that appeared in /search

Either the signing secret changed (all IDs invalidated) or the upstream's stream URL expired between search and play. Re-search and retry.

Build prints error TS... but Vercel deploys anyway

Vercel runs tsc without failing on type errors by default. Add "noEmitOnError": true to tsconfig.json → compilerOptions to make build failures actually fail.

---

Adding a source

1. Create src/providers/<name>.ts implementing QobuzProvider:
   ```ts
   interface QobuzProvider {
     search(query: string, quality: Quality, atmos: string): Promise<QobuzTrack[]>;
     getStream(trackId: string, quality: Quality, atmos: string): Promise<QobuzStream | null>;
   }
   ```
2. Add a case to buildFor() in src/providers/index.ts, gated by config.enabledSources.has('<name>').
3. Add the name to IsolatedSource and to KNOWN_SOURCES in src/config.ts.
4. Wire an isolated route in src/server.ts if you want it reachable via /x.
5. Add the name to QOBUZ_ENABLED_SOURCES when you want it live.

getStream must return a URL that passes streamResponse(): https:// only, encrypted !== true, manifest type one of none | hls | dash. Anything else returns 404 to BitChord.

---

License

No license file included. Add one if you intend to share this. Upstream services are third-party and not affiliated with this addon; they can change or shut down at any time. QOBUZ_ENABLED_SOURCES is the kill switch — if an upstream dies, drop it from the list and redeploy.

```
