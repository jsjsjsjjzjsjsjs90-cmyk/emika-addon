# Integration audit evidence

- BitChord source: https://github.com/kushagrasinghx/BitChord
  - `AddonClient` sends `quality=LOSSLESS|HIGH|LOW` for ordinary tiers, `atmos=auto` when Atmos is wanted, and the lossless resolver explicitly tries `quality=atmos` with `atmos=auto` for Dolby Atmos.
  - `AddonModels.AddonStream` reads `sampleRate`, `bitDepth`, `audioMode`, `audioModes`, `atmos`, `streamQuality`, `encrypted`, and nested metadata aliases.
  - The lossless resolver treats `quality=atmos` as the explicit immersive attempt and rejects a spatial stream during stereo tiers.

- LastWave source: https://github.com/Clash-Projects/LastWave-Native
  - `app/src/main/java/com/lastwave/app/data/addon/AddonClient.kt` sends `quality=atmos&atmos=auto` for its Atmos attempt and `atmos=none` for non-Atmos requests.
  - `app/src/main/java/com/lastwave/app/data/addon/AddonModels.kt` parses `sampleRate`, `bitDepth`, `audioMode`, `audioModes`, `atmos`, nested metadata, and Hi-Res labels.
  - `app/src/main/java/com/lastwave/app/data/lossless/LosslessMusicApi.kt` maps Atmos to an explicit `quality=atmos` stream attempt, Hi-Res to `quality=hi_res`, and validates stream metadata before selecting the final tier.

- Verified Emika live behavior before this audit:
  - `https://emika-addon.vercel.app/manifest.json` returned resources `search, stream`.
  - Search and stream worked with BitChord/v1.9 and `atmos=auto`.
  - Emika previously rejected `quality=atmos`; this is incompatible with BitChord/LastWave explicit Atmos stream attempts. The fix maps `atmos` and `dolby_atmos` to the LOSSLESS internal tier while preserving the separate Atmos mode parameter.
