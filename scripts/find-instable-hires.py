#!/usr/bin/env python3
"""Find Instable/Qobuz albums advertised as 96 or 192 kHz and verify streams.

Examples:
  python3 scripts/find-instable-hires.py
  python3 scripts/find-instable-hires.py --queries "jazz,classical,orchestra" --verify-streams 3
  python3 scripts/find-instable-hires.py --min-khz 192 --verify-streams 5
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

DEFAULT_BASE = "https://instable.arcod.xyz"
DEFAULT_QUERIES = [
    "jazz", "classical", "orchestra", "piano", "audiophile",
    "acoustic", "remastered", "soundtrack", "vinyl", "ambient",
]


@dataclass(frozen=True)
class Candidate:
    track_id: str
    title: str
    artist: str
    advertised_khz: float
    bit_depth: int | None
    hires: bool
    query: str


def get_json(url: str, user_agent: str, timeout: float) -> Any:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": user_agent},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def record(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def nested_items(value: Any) -> list[dict[str, Any]]:
    """Extract album/track items from the several response shapes Instable uses."""
    out: list[dict[str, Any]] = []
    root = record(value) or {}
    data = record(root.get("data")) or root

    for key in ("tracks", "albums"):
        collection = data.get(key)
        if isinstance(collection, list):
            out.extend(item for item in collection if isinstance(item, dict))
        elif isinstance(collection, dict) and isinstance(collection.get("items"), list):
            out.extend(item for item in collection["items"] if isinstance(item, dict))

    return out


def number(value: Any) -> float | None:
    return value if isinstance(value, (int, float)) and value > 0 else None


def artist_name(item: dict[str, Any]) -> str:
    artist = item.get("artist")
    if isinstance(artist, dict) and isinstance(artist.get("name"), str):
        return artist["name"]
    if isinstance(item.get("performer"), dict) and isinstance(item["performer"].get("name"), str):
        return item["performer"]["name"]
    return "Unknown artist"


def candidate_from(item: dict[str, Any], query: str, min_khz: float) -> Candidate | None:
    track_id = item.get("qobuz_id", item.get("id"))
    title = item.get("title")
    sampling = number(item.get("maximum_sampling_rate"))
    if not isinstance(track_id, (str, int)) or not isinstance(title, str) or sampling is None:
        return None
    if sampling < min_khz or item.get("hires") is not True:
        return None
    bit_depth = item.get("maximum_bit_depth")
    return Candidate(
        track_id=str(track_id),
        title=title.strip(),
        artist=artist_name(item),
        advertised_khz=sampling,
        bit_depth=bit_depth if isinstance(bit_depth, int) else None,
        hires=True,
        query=query,
    )


def probe_stream(base: str, candidate: Candidate, user_agent: str, timeout: float) -> dict[str, Any]:
    path = "/api/player/stream/" + urllib.parse.quote(candidate.track_id, safe="")
    query = urllib.parse.urlencode({"quality": "27", "atmos": "off"})
    body = get_json(base.rstrip("/") + path + "?" + query, user_agent, timeout)
    result: dict[str, Any] = {
        "apiQuality": body.get("quality") if isinstance(body, dict) else None,
        "mimeType": body.get("mimeType") if isinstance(body, dict) else None,
        "url": body.get("url") if isinstance(body, dict) else None,
    }
    if shutil.which("ffprobe") and isinstance(result["url"], str):
        command = [
            "ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=codec_name,sample_rate,bits_per_raw_sample,channels,channel_layout",
            "-of", "json", "-rw_timeout", str(int(timeout * 1_000_000)), result["url"],
        ]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout + 5)
        try:
            streams = json.loads(completed.stdout).get("streams", [])
            result["actual"] = streams[0] if streams else None
        except (json.JSONDecodeError, IndexError):
            result["actual"] = None
    result.pop("url", None)  # Do not print signed media URLs.
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--queries", default=",".join(DEFAULT_QUERIES), help="comma-separated search terms")
    parser.add_argument("--per-query", type=int, default=10)
    parser.add_argument("--min-khz", type=float, default=96)
    parser.add_argument("--verify-streams", type=int, default=5)
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--seed", type=int, default=None)
    args = parser.parse_args()

    if args.seed is not None:
        random.seed(args.seed)
    queries = [q.strip() for q in args.queries.split(",") if q.strip()]
    random.shuffle(queries)
    user_agent = "BitChord/v1.9"
    candidates: dict[str, Candidate] = {}

    print(f"Instable: {args.base}")
    print(f"Searching {len(queries)} random queries; threshold >= {args.min_khz:g} kHz")
    for query in queries:
        params = urllib.parse.urlencode({"q": query, "limit": str(args.per_query), "atmos": "off"})
        try:
            body = get_json(args.base.rstrip("/") + "/api/search?" + params, user_agent, args.timeout)
        except Exception as exc:
            print(f"[search error] {query}: {exc}", file=sys.stderr)
            continue
        found = 0
        for item in nested_items(body):
            candidate = candidate_from(item, query, args.min_khz)
            if candidate and candidate.track_id not in candidates:
                candidates[candidate.track_id] = candidate
                found += 1
        print(f"{query}: {found} candidate(s)")

    ordered = list(candidates.values())
    random.shuffle(ordered)
    print(f"\nCandidates: {len(ordered)}")
    for index, candidate in enumerate(ordered):
        depth = f"{candidate.bit_depth}-bit" if candidate.bit_depth else "bit depth n/a"
        print(f"{index + 1}. {candidate.title} — {candidate.artist} | advertised {candidate.advertised_khz:g} kHz, {depth} | id={candidate.track_id}")

    if args.verify_streams <= 0:
        return 0
    print(f"\nVerifying up to {min(args.verify_streams, len(ordered))} stream(s) with quality=27...")
    for candidate in ordered[:args.verify_streams]:
        try:
            result = probe_stream(args.base, candidate, user_agent, args.timeout)
            print(json.dumps({"title": candidate.title, "trackId": candidate.track_id, **result}, ensure_ascii=False))
        except Exception as exc:
            print(json.dumps({"title": candidate.title, "trackId": candidate.track_id, "error": str(exc)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
