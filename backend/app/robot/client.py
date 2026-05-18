"""TCP client for the RAPID RobotServer module.

Wire protocol (ASCII, LF-terminated):

    Python -> RAPID:   PING <seq>\\n
                       HOME <seq>\\n
                       MOVE <seq> <x_mm> <y_mm> <z_mm>\\n

    RAPID  -> Python:  ACK  <seq> <result>\\n

Result codes:
    0  OK
    1  UNREACHABLE         motion supervision tripped / target out of reach
    2  PROTOCOL_ERROR      controller could not parse the command
    3  INTERNAL_ERROR      controller-side fault not covered by the above

The client is sync. FastAPI handlers can call it directly (sync def routes
run in a threadpool) or wrap calls in asyncio.to_thread for explicit control.
A single instance is safe to share across threads: an internal lock
serialises one command/ack round-trip at a time, which is what the RAPID
side expects.
"""
from __future__ import annotations

import logging
import socket
import threading

log = logging.getLogger(__name__)


class RobotError(Exception):
    """Base class for all robot-comm failures."""


class RobotProtocolError(RobotError):
    """Wire-level problem: malformed reply, seq mismatch, controller rejected the verb."""


class RobotMotionError(RobotError):
    """The robot received the command but couldn't execute it (unreachable, fault)."""


class RobotTimeoutError(RobotError):
    """No reply within the configured deadline."""


RESULT_OK = 0
RESULT_UNREACHABLE = 1
RESULT_PROTOCOL_ERROR = 2
RESULT_INTERNAL_ERROR = 3


class RobotClient:
    def __init__(
        self,
        host: str,
        port: int,
        connect_timeout_s: float = 5.0,
        motion_timeout_s: float = 30.0,
    ) -> None:
        self.host = host
        self.port = port
        self.connect_timeout_s = connect_timeout_s
        self.motion_timeout_s = motion_timeout_s

        self._sock: socket.socket | None = None
        self._rx = None  # binary file wrapper for readline()
        self._lock = threading.Lock()
        self._seq = 0

    # ---- connection lifecycle --------------------------------------------

    def connect(self) -> None:
        if self._sock is not None:
            return
        log.info("connecting to robot at %s:%d", self.host, self.port)
        sock = socket.create_connection(
            (self.host, self.port), timeout=self.connect_timeout_s
        )
        self._sock = sock
        self._rx = sock.makefile("rb")

    def close(self) -> None:
        # Send QUIT so RAPID closes its end first. Without this, RobotWare
        # raises a "connection has been closed by the remote host" event
        # that halts the task outside RAPID's exception flow (SkipWarn
        # can't suppress it). QUIT is best-effort — if anything fails we
        # still close the local socket below.
        if self._sock is not None and self._rx is not None:
            try:
                self._request("QUIT {seq}", motion=False)
            except RobotError:
                pass
            except OSError:
                pass

        with self._lock:
            if self._rx is not None:
                try:
                    self._rx.close()
                except OSError:
                    pass
                self._rx = None
            if self._sock is not None:
                try:
                    self._sock.close()
                except OSError:
                    pass
                self._sock = None

    def __enter__(self) -> "RobotClient":
        self.connect()
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ---- public command surface ------------------------------------------

    def ping(self) -> None:
        self._request("PING {seq}", motion=False)

    def home(self) -> None:
        self._request("HOME {seq}", motion=True)

    def move_to(self, x_mm: float, y_mm: float, z_mm: float) -> None:
        self._request(
            f"MOVE {{seq}} {x_mm:.3f} {y_mm:.3f} {z_mm:.3f}",
            motion=True,
        )

    def step(self, step_number: int) -> None:
        """Invoke a state-machine step by number — bridges to ExecStepMachine
        on the RAPID side. Step numbers come from States.mod (40=home,
        110/120/210/220/310/410=table corners, 600/610=pick).
        """
        self._request(f"STEP {{seq}} {step_number}", motion=True)

    # ---- internals -------------------------------------------------------

    def _request(self, line_template: str, *, motion: bool) -> None:
        with self._lock:
            if self._sock is None or self._rx is None:
                raise RobotError("not connected — call connect() first")
            self._seq += 1
            seq = self._seq
            line = line_template.format(seq=seq)
            payload = (line + "\n").encode("ascii")

            self._sock.settimeout(
                self.motion_timeout_s if motion else self.connect_timeout_s
            )
            log.debug("→ %s", line)
            try:
                self._sock.sendall(payload)
                reply = self._rx.readline()
            except socket.timeout as e:
                raise RobotTimeoutError(f"no reply to {line!r}") from e

            if not reply:
                raise RobotProtocolError("connection closed by robot")
            reply_str = reply.decode("ascii").rstrip("\r\n")
            log.debug("← %s", reply_str)

            tokens = reply_str.split()
            if len(tokens) < 3 or tokens[0] != "ACK":
                raise RobotProtocolError(f"malformed reply: {reply_str!r}")
            try:
                ack_seq = int(tokens[1])
                result = int(tokens[2])
            except ValueError as e:
                raise RobotProtocolError(f"non-numeric fields in {reply_str!r}") from e

            if ack_seq != seq:
                raise RobotProtocolError(
                    f"seq mismatch: sent {seq}, got {ack_seq}"
                )

            if result == RESULT_OK:
                return
            if result == RESULT_UNREACHABLE:
                raise RobotMotionError(f"unreachable: {line}")
            if result == RESULT_PROTOCOL_ERROR:
                raise RobotProtocolError(f"controller rejected: {line}")
            raise RobotError(f"unknown result {result} for {line}")
