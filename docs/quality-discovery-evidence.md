# Quality discovery evidence

- Qobuz-DL API repository: https://github.com/audio-music-streamer/Qobuz-DL-API
  - `/api/get-music?q=...`
  - `/api/download-music?track_id=...&quality=27`
  - documented IDs: 27 = 24-bit/192kHz maximum, 7 = 24-bit/96kHz, 6 = 16-bit/44.1kHz, 5 = MP3 320kbps.
- qobuz-dl reference: https://github.com/vitiko98/qobuz-dl
  - supports FLAC/MP3, Hi-Res quality selection and embedded artwork/metadata.
- BitChord repository: https://github.com/kushagrasinghx/BitChord
  - addon client sends the selected quality in search and stream settings; `streamURL` can be used as a complete stream request.
- LastWave Native repository: https://github.com/Clash-Projects/LastWave-Native
  - native client supports addon search/stream/download flows and reads stream metadata.
- Production verification on 2026-11-04:
  - `/a/search?q=vagas doja cat&quality=hi-res` returned Doja Cat Vegas at 96000 Hz/24-bit.
  - `/a/stream/<id>` with no quality defaults to LOSSLESS and returned 44100 Hz/16-bit.
  - `/a/stream/<id>?quality=hi-res&atmos=auto` returned 96000 Hz/24-bit.
  - LastWave search response included a `streamURL` with `quality=hi_res`.
