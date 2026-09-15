#!/usr/bin/env python3
"""Hold the shared Nous provider-attempt lock until stdin reaches EOF.

The installed MCP bridge uses the same lock name and cache layout.  This
helper deliberately accepts no credentials or provider data; its only input
is the bounded timeout argument and the path/runtime environment supplied by
the Node adapter.
"""

from __future__ import annotations

import argparse
import math
import os
import stat
import sys
import time
from pathlib import Path

if os.name == "nt":  # pragma: no cover - Windows acceptance is separate.
    import msvcrt
else:
    import fcntl


ACQUIRED_LINE = "NOUS_PROVIDER_ATTEMPT_LOCK_ACQUIRED"
DEFAULT_TIMEOUT_SECONDS = 600.0


class LockError(RuntimeError):
    """A local lock protocol or security error."""


def secure_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise LockError(f"lock directory is not a real directory: {path}")
    try:
        os.chmod(path, 0o700)
    except OSError:
        if os.name != "nt":
            raise


def cache_root() -> Path:
    configured = os.environ.get("XDG_CACHE_HOME")
    return Path(configured) if configured else Path.home() / ".cache"


def lock_path() -> Path:
    return cache_root() / "codex-nous" / "provider-attempt.lock"


def open_lock(path: Path) -> int:
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as error:
        raise LockError(f"cannot open provider-attempt lock: {error}") from error
    if hasattr(os, "fchmod"):
        try:
            os.fchmod(descriptor, 0o600)
        except OSError:
            if os.name != "nt":
                os.close(descriptor)
                raise
    return descriptor


def try_lock(descriptor: int) -> bool:
    if os.name == "nt":  # pragma: no cover - Windows acceptance is separate.
        os.lseek(descriptor, 0, os.SEEK_SET)
        try:
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False


def unlock(descriptor: int) -> None:
    if os.name == "nt":  # pragma: no cover - Windows acceptance is separate.
        os.lseek(descriptor, 0, os.SEEK_SET)
        try:
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        return
    fcntl.flock(descriptor, fcntl.LOCK_UN)


def hold(timeout_seconds: float) -> None:
    if timeout_seconds <= 0 or not math.isfinite(timeout_seconds):
        raise LockError("lock timeout must be a positive finite number")
    path = lock_path()
    secure_directory(path.parent)
    descriptor = open_lock(path)
    acquired = False
    started = time.monotonic()
    try:
        while not acquired:
            acquired = try_lock(descriptor)
            if acquired:
                break
            if time.monotonic() - started >= timeout_seconds:
                raise LockError("timed out waiting for provider-attempt lock")
            time.sleep(0.05)
        sys.stdout.write(ACQUIRED_LINE + "\n")
        sys.stdout.flush()
        # Reading until EOF keeps the descriptor and the OS lock alive.  The
        # parent closes stdin only after the provider attempt is complete.
        while True:
            chunk = sys.stdin.buffer.read(65536)
            if not chunk:
                break
    finally:
        if acquired:
            unlock(descriptor)
        os.close(descriptor)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
        help="maximum time to wait for the shared lock",
    )
    return parser.parse_args()


def main() -> int:
    try:
        hold(parse_args().timeout_seconds)
    except (LockError, OSError, ValueError) as error:
        sys.stderr.write(f"nous provider lock: {error}\n")
        sys.stderr.flush()
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
