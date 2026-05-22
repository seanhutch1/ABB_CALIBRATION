"""Measure Python<->RAPID comms reliability and round-trip latency.

Covers Sections 4.1 (PING-storm robustness) and 4.2 (round-trip latency) of
the measurement plan in one script. Opens a single RobotClient and pings N
times back-to-back, recording per-call latency and tallying failure modes.

Run from the backend/ directory so `app` is importable:

    cd backend
    python -m scripts.measure_comms          # default 100 pings
    python -m scripts.measure_comms -n 50    # 50 pings
    python -m scripts.measure_comms -n 100 --csv pings.csv

Or with PYTHONPATH from the repo root:

    $env:PYTHONPATH = "backend"
    python -m scripts.measure_comms -n 100
"""
from __future__ import annotations

import argparse
import csv
import statistics
import sys
import time
from dataclasses import dataclass

from app.config import settings
from app.robot.client import (
    RobotClient,
    RobotError,
    RobotMotionError,
    RobotProtocolError,
    RobotTimeoutError,
)


@dataclass
class PingResult:
    seq: int
    ok: bool
    latency_ms: float
    error_kind: str | None  # None | "timeout" | "protocol" | "motion" | "other"
    error_text: str | None


def storm(client: RobotClient, count: int, verbose: bool) -> list[PingResult]:
    out: list[PingResult] = []
    for i in range(count):
        t0 = time.perf_counter()
        kind: str | None = None
        text: str | None = None
        try:
            client.ping()
        except RobotTimeoutError as e:
            kind, text = "timeout", str(e)
        except RobotProtocolError as e:
            kind, text = "protocol", str(e)
        except RobotMotionError as e:
            kind, text = "motion", str(e)
        except RobotError as e:
            kind, text = "other", str(e)
        latency_ms = (time.perf_counter() - t0) * 1000.0
        ok = kind is None
        out.append(PingResult(seq=i + 1, ok=ok, latency_ms=latency_ms, error_kind=kind, error_text=text))
        if verbose:
            tag = "ok" if ok else f"FAIL[{kind}]"
            print(f"  ping {i+1:>4}/{count}: {tag} {latency_ms:7.2f} ms")
    return out


def summarise(results: list[PingResult]) -> None:
    n = len(results)
    oks = [r for r in results if r.ok]
    fails = [r for r in results if not r.ok]
    ok_lat = [r.latency_ms for r in oks]

    print()
    print("=" * 56)
    print(f"PING storm results: {len(oks)}/{n} succeeded ({100 * len(oks) / n:.1f}%)")
    print("=" * 56)

    if ok_lat:
        print(f"Latency (ms, successes only, n={len(ok_lat)}):")
        print(f"  mean   : {statistics.fmean(ok_lat):7.2f}")
        if len(ok_lat) >= 2:
            print(f"  std    : {statistics.stdev(ok_lat):7.2f}")
        print(f"  min    : {min(ok_lat):7.2f}")
        print(f"  max    : {max(ok_lat):7.2f}")
        srt = sorted(ok_lat)
        if len(srt) >= 20:
            p50 = srt[len(srt) // 2]
            p95 = srt[int(0.95 * len(srt))]
            p99 = srt[int(0.99 * len(srt))]
            print(f"  p50/95/99: {p50:.2f} / {p95:.2f} / {p99:.2f}")

    if fails:
        print()
        print("Failure breakdown:")
        kinds: dict[str, int] = {}
        for r in fails:
            k = r.error_kind or "other"
            kinds[k] = kinds.get(k, 0) + 1
        for k, c in sorted(kinds.items()):
            print(f"  {k:10s}: {c}")
        print()
        print("First 5 failure details:")
        for r in fails[:5]:
            print(f"  seq {r.seq}: [{r.error_kind}] {r.error_text}")


def write_csv(results: list[PingResult], path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["seq", "ok", "latency_ms", "error_kind", "error_text"])
        for r in results:
            w.writerow([r.seq, r.ok, f"{r.latency_ms:.3f}", r.error_kind or "", r.error_text or ""])
    print(f"\nWrote {len(results)} rows to {path}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="measure_comms")
    p.add_argument("-n", "--count", type=int, default=100, help="number of PINGs (default 100)")
    p.add_argument("--host", default=settings.robot.host)
    p.add_argument("--port", type=int, default=settings.robot.port)
    p.add_argument("--csv", help="optional path to dump per-ping results as CSV")
    p.add_argument("-v", "--verbose", action="store_true", help="print one line per ping")
    args = p.parse_args(argv)

    print(f"Connecting to {args.host}:{args.port} ...")
    try:
        with RobotClient(
            host=args.host,
            port=args.port,
            connect_timeout_s=settings.robot.connect_timeout_s,
            motion_timeout_s=settings.robot.motion_timeout_s,
        ) as client:
            print(f"Connected. Firing {args.count} pings ...")
            t_start = time.perf_counter()
            results = storm(client, args.count, args.verbose)
            elapsed = time.perf_counter() - t_start
    except (ConnectionError, OSError) as e:
        print(f"connect failed: {e}", file=sys.stderr)
        return 1
    except RobotError as e:
        print(f"setup error: {e}", file=sys.stderr)
        return 2

    summarise(results)
    print(f"\nTotal wall time: {elapsed:.2f} s ({len(results)/elapsed:.1f} pings/s)")
    if args.csv:
        write_csv(results, args.csv)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
