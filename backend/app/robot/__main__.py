"""Standalone CLI for RobotClient.

Useful for verifying the controller link without booting the FastAPI server.
Defaults read from the same config layer (env vars / .env) as the backend, so
the CLI and the GUI talk to the same robot with no per-tool configuration.

Examples:
    python -m app.robot ping
    python -m app.robot home
    python -m app.robot move-to 580 325 305
    python -m app.robot --host 192.168.125.1 ping
"""
from __future__ import annotations

import argparse
import logging
import sys

from app.config import settings
from app.robot.client import (
    RobotClient,
    RobotError,
    RobotMotionError,
    RobotProtocolError,
    RobotTimeoutError,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.robot")
    parser.add_argument("--host", default=settings.robot.host)
    parser.add_argument("--port", type=int, default=settings.robot.port)
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("ping", help="round-trip check; returns immediately")
    sub.add_parser("home", help="move to the controller's HOME pose")
    mv = sub.add_parser("move-to", help="linear move to absolute (x y z) in mm")
    mv.add_argument("x", type=float)
    mv.add_argument("y", type=float)
    mv.add_argument("z", type=float)
    st = sub.add_parser("step", help="invoke a state-machine step by number (e.g. 40, 110, 220)")
    st.add_argument("number", type=int)

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    try:
        with RobotClient(
            host=args.host,
            port=args.port,
            connect_timeout_s=settings.robot.connect_timeout_s,
            motion_timeout_s=settings.robot.motion_timeout_s,
        ) as client:
            if args.cmd == "ping":
                client.ping()
                print("OK")
            elif args.cmd == "home":
                client.home()
                print("home: OK")
            elif args.cmd == "move-to":
                client.move_to(args.x, args.y, args.z)
                print(f"moved to ({args.x:.3f}, {args.y:.3f}, {args.z:.3f}) mm")
            elif args.cmd == "step":
                client.step(args.number)
                print(f"step {args.number}: OK")
    except RobotTimeoutError as e:
        print(f"timeout: {e}", file=sys.stderr)
        return 2
    except RobotMotionError as e:
        print(f"motion: {e}", file=sys.stderr)
        return 3
    except RobotProtocolError as e:
        print(f"protocol: {e}", file=sys.stderr)
        return 4
    except RobotError as e:
        print(f"error: {e}", file=sys.stderr)
        return 5
    except (ConnectionError, OSError) as e:
        print(f"connect failed: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
