# Emika Extension for Mornye

This directory contains the Mornye `.sflx` package and its source/tests for using Emika as a metadata and direct-audio download provider.

## Install

Install `emika.sflx` in Mornye 5.3.0 or newer. Configure the endpoint to an Emika deployment that Mornye can access and that has downloads enabled.

The provider supports direct audio downloads and validates the resulting file when the Mornye runtime exposes `gobackend.getAudioQuality`. It rejects segmented DASH/MPD responses and refuses an advertised Lossless rendition when the measured codec is not FLAC.

## Private deployments

A deployment protected by `EMIKA_BITCHORD_AUTH=1` requires `X-BitChord-Token` and `X-BitChord-Proof`. The current Mornye adapter does not mint BitChord proof credentials, so use an endpoint authorized for Mornye or add an auth bridge before pointing this extension at a private BitChord-only deployment.

## Verification

Run the standalone tests from this repository with:

```sh
node --test mornye-extension/tests/emika_download.test.cjs mornye-extension/tests/emika_mock_integration.test.cjs
node --check mornye-extension/sources/emika/index.js
unzip -t mornye-extension/emika.sflx
```
