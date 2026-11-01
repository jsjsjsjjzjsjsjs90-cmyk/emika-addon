#!/usr/bin/env python3
"""Integration test for Emika as consumed by BitChord and LastWave.

Only Python's standard library is required. The script does not print signed
media URLs or addon tokens. It tests the HTTP addon contract, not private
BitChord/LastWave app internals.

Examples:
  python3 scripts/test-bitchord-lastwave-integration.py
  python3 scripts/test-bitchord-lastwave-integration.py --base https://example.com --query "Blue Train"
  python3 scripts/test-bitchord-lastwave-integration.py --json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


@dataclass
class Check:
    name: str
    ok: bool
    status: int | None = None
    detail: str = ""
    data: dict[str, Any] = field(default_factory=dict)


class Client:
    def __init__(self, base: str, user_agent: str, timeout: float) -> None:
        self.base = base.rstrip("/")
        self.user_agent = user_agent
        self.timeout = timeout

    def get(self, path: str, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], Any]:
        request_headers = {
            "User-Agent": self.user_agent,
            "Accept": "application/json",
        }
        if headers:
            request_headers.update(headers)
        request = Request(self.base + path, headers=request_headers, method="GET")
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
                return response.status, dict(response.headers.items()), self._decode(raw)
        except HTTPError as error:
            raw = error.read()
            return error.code, dict(error.headers.items()), self._decode(raw)
        except (URLError, TimeoutError, OSError) as error:
            return 0, {}, {"_error": str(error)}

    @staticmethod
    def _decode(raw: bytes) -> Any:
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {"_rawBytes": len(raw)}


def is_dict(value: Any) -> bool:
    return isinstance(value, dict)


def check_json(
    name: str,
    status: int,
    body: Any,
    expected_status: int = 200,
    required: tuple[str, ...] = (),
) -> Check:
    missing = [key for key in required if not isinstance(body, dict) or key not in body]
    ok = status == expected_status and not missing
    detail = "HTTP %s" % status if status else "request failed"
    if missing:
        detail += "; missing: " + ", ".join(missing)
    if isinstance(body, dict) and "error" in body:
        detail += "; error response present"
    return Check(name, ok, status, detail)


def safe_stream_summary(stream: dict[str, Any]) -> dict[str, Any]:
    """Return stream fields without exposing the signed URL."""
    return {
        key: stream.get(key)
        for key in (
            "format",
            "codec",
            "container",
            "quality",
            "audioQuality",
            "sampleRate",
            "bitDepth",
            "audioMode",
            "audioModes",
            "atmos",
            "manifest",
            "encrypted",
        )
        if key in stream
    }


def add(checks: list[Check], check: Check, **data: Any) -> None:
    check.data.update(data)
    checks.append(check)


def run(args: argparse.Namespace) -> list[Check]:
    checks: list[Check] = []
    base = args.base.rstrip("/")
    bitchord = Client(base, "BitChord/v1.9", args.timeout)
    lastwave_player = Client(base, "LastWave-Player/1.0", args.timeout)
    lastwave_downloader = Client(base, "LastWave-Downloader/1.0", args.timeout)

    # Emika operational endpoints.
    status, _, body = bitchord.get("/")
    add(checks, check_json("GET /", status, body, required=()), response_type=type(body).__name__)

    status, _, body = bitchord.get("/health")
    add(checks, check_json("GET /health", status, body, required=("ok",)))

    status, _, body = bitchord.get("/health/sources?q=" + quote(args.query, safe=""))
    source_check = check_json("GET /health/sources", status, body, required=("overallStatus", "providers"))
    add(checks, source_check, overallStatus=body.get("overallStatus") if is_dict(body) else None)

    # BitChord and LastWave both begin with manifest.json.
    status, _, manifest = bitchord.get("/manifest.json")
    manifest_check = check_json("BitChord GET /manifest.json", status, manifest, required=("id", "resources"))
    if is_dict(manifest):
        resources = {str(item).lower() for item in manifest.get("resources", []) if isinstance(item, str)}
        manifest_check.ok = manifest_check.ok and {"search", "stream"}.issubset(resources)
        manifest_check.detail += "; resources=" + ",".join(sorted(resources))
    add(checks, manifest_check)

    # Test every isolated manifest route. These are public Emika endpoints but
    # their providers may be disabled or unhealthy; manifest must still route.
    for prefix, label in (("/a", "qobuzdl"), ("/b", "lastbabe"), ("/c", "monochrome"),
                          ("/d", "deezer"), ("/e", "eljohnzc"), ("/f", "instable")):
        status, _, isolated_manifest = bitchord.get(prefix + "/manifest.json")
        add(checks, check_json(f"GET {prefix}/manifest.json ({label})", status, isolated_manifest,
                               required=("id", "resources")))

    # BitChord's normal flow: LOSSLESS search + atmos=auto, then stream.
    search_query = "/search?" + urlencode({"q": args.query, "quality": "lossless", "atmos": "auto"})
    status, _, search = bitchord.get(search_query)
    search_check = check_json("BitChord search lossless/auto", status, search, required=("tracks",))
    tracks = search.get("tracks", []) if is_dict(search) else []
    search_check.ok = search_check.ok and isinstance(tracks, list)
    add(checks, search_check, count=len(tracks) if isinstance(tracks, list) else 0)

    if not tracks:
        add(checks, Check("BitChord stream flow", False, status, "search returned no tracks"))
        add(checks, Check("LastWave stream flow", False, status, "search returned no tracks"))
        return checks

    track = tracks[0] if isinstance(tracks[0], dict) else {}
    track_id = track.get("id")
    if not isinstance(track_id, str) or not track_id:
        add(checks, Check("Track ID contract", False, status, "first track has no string id"))
        return checks
    add(checks, Check("Track ID contract", True, 200, "opaque ID present"),
        title=track.get("title"), audioQuality=track.get("audioQuality"),
        sampleRate=track.get("sampleRate"), bitDepth=track.get("bitDepth"))

    # BitChord URL-encodes the path segment and sends atmos=auto.
    encoded_id = quote(track_id, safe="")
    path = "/stream/" + encoded_id + "?" + urlencode({"quality": "lossless", "atmos": "auto"})
    status, _, stream = bitchord.get(path)
    stream_check = check_json("BitChord stream lossless/auto", status, stream, required=("url", "format", "quality"))
    if is_dict(stream):
        stream_check.ok = stream_check.ok and stream.get("url", "").startswith("https://") and stream.get("encrypted") is not True
    add(checks, stream_check, stream=safe_stream_summary(stream) if is_dict(stream) else {})

    # BitChord's explicit Atmos attempt (also used by LastWave's resolver).
    status, _, atmos_stream = bitchord.get(
        "/stream/" + encoded_id + "?" + urlencode({"quality": "atmos", "atmos": "auto"})
    )
    atmos_check = check_json("BitChord explicit Atmos stream", status, atmos_stream, required=("url", "format", "quality"))
    if is_dict(atmos_stream):
        atmos_check.ok = atmos_check.ok and atmos_stream.get("url", "").startswith("https://")
    add(checks, atmos_check, stream=safe_stream_summary(atmos_stream) if is_dict(atmos_stream) else {})

    # LastWave's search uses lossless + auto for an Atmos-preferred lookup.
    status, _, lw_search = lastwave_player.get(search_query)
    lw_search_check = check_json("LastWave search lossless/auto", status, lw_search, required=("tracks",))
    lw_tracks = lw_search.get("tracks", []) if is_dict(lw_search) else []
    lw_search_check.ok = lw_search_check.ok and isinstance(lw_tracks, list)
    add(checks, lw_search_check, count=len(lw_tracks) if isinstance(lw_tracks, list) else 0)

    # LastWave sends the explicit quality=atmos attempt with the raw safe ID.
    status, _, lw_atmos = lastwave_player.get(
        "/stream/" + track_id + "?" + urlencode({"quality": "atmos", "atmos": "auto"}),
        {"X-LW-Intent": "stream"},
    )
    lw_atmos_check = check_json("LastWave Atmos stream", status, lw_atmos, required=("url", "format", "quality"))
    if is_dict(lw_atmos):
        lw_atmos_check.ok = lw_atmos_check.ok and lw_atmos.get("url", "").startswith("https://")
    add(checks, lw_atmos_check, stream=safe_stream_summary(lw_atmos) if is_dict(lw_atmos) else {})

    # LastWave's Hi-Res and non-Atmos flow.
    status, _, lw_hires = lastwave_player.get(
        "/stream/" + track_id + "?" + urlencode({"quality": "hi_res", "atmos": "none"}),
        {"X-LW-Intent": "stream"},
    )
    lw_hires_check = check_json("LastWave Hi-Res stream", status, lw_hires, required=("url", "format", "quality"))
    if is_dict(lw_hires):
        lw_hires_check.ok = lw_hires_check.ok and lw_hires.get("url", "").startswith("https://")
    add(checks, lw_hires_check, stream=safe_stream_summary(lw_hires) if is_dict(lw_hires) else {})

    # Download intent is a protocol/header check. It does not download the
    # whole file; a signed URL is tested with a four-byte Range request below.
    status, _, download_stream = lastwave_downloader.get(
        "/stream/" + track_id + "?" + urlencode({"quality": "lossless", "atmos": "none"}),
        {"X-LW-Intent": "download"},
    )
    download_check = check_json("LastWave download intent", status, download_stream, required=("url", "format"))
    if is_dict(download_stream):
        download_check.ok = download_check.ok and download_stream.get("url", "").startswith("https://")
    add(checks, download_check, stream=safe_stream_summary(download_stream) if is_dict(download_stream) else {})

    # Verify the returned media is reachable and starts with an audio payload.
    if is_dict(download_stream) and isinstance(download_stream.get("url"), str):
        media_url = download_stream["url"]
        media_request = Request(media_url, headers={"User-Agent": "LastWave-Player/1.0", "Range": "bytes=0-3"})
        try:
            with urlopen(media_request, timeout=args.timeout) as response:
                first = response.read(4)
                media_ok = response.status in (200, 206) and len(first) == 4
                add(checks, Check("Signed media Range request", media_ok, response.status,
                                  "content-type=" + response.headers.get("content-type", "")),
                    contentType=response.headers.get("content-type"), first4=first.hex())
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            add(checks, Check("Signed media Range request", False, 0, str(error)))

    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="https://emika-addon.vercel.app", help="Emika base URL")
    parser.add_argument("--query", default="Blue Train John Coltrane", help="Search query")
    parser.add_argument("--timeout", type=float, default=30.0, help="Per-request timeout in seconds")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    args = parser.parse_args()

    started = time.time()
    checks = run(args)
    elapsed_ms = round((time.time() - started) * 1000)
    passed = sum(check.ok for check in checks)
    result = {
        "base": args.base.rstrip("/"),
        "query": args.query,
        "checks": [
            {"name": check.name, "ok": check.ok, "status": check.status,
             "detail": check.detail, **check.data}
            for check in checks
        ],
        "passed": passed,
        "total": len(checks),
        "failed": len(checks) - passed,
        "elapsedMs": elapsed_ms,
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"Emika integration test: {args.base.rstrip('/')}")
        print(f"Query: {args.query!r} | elapsed: {elapsed_ms} ms")
        for check in checks:
            icon = "PASS" if check.ok else "FAIL"
            status = f" HTTP {check.status}" if check.status else ""
            print(f"[{icon}] {check.name}{status} — {check.detail}")
            if check.data.get("stream"):
                print("       stream=" + json.dumps(check.data["stream"], ensure_ascii=False, separators=(",", ":")))
        print(f"Summary: {passed}/{len(checks)} passed")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
