"""Process-local GPU generation lease for coordinating this application's jobs."""

from __future__ import annotations

import contextlib
import ctypes
import errno
import json
import os
import re
import stat
import sys
import uuid
from pathlib import Path
from typing import Iterator


class GPU_BUSY(RuntimeError):
    """Another process owns the GPU lease, or its liveness cannot be checked."""


class GPU_LOCK_INVALID(RuntimeError):
    """The lease path or contents are unsafe or invalid."""


_RUN_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
_MAX_LEASE_BYTES = 4096


def _lease_path(project_root: Path) -> Path:
    return Path(project_root) / "data" / "reconstruction" / "gpu-lease.json"


def _is_reparse_point(info: os.stat_result) -> bool:
    attrs = getattr(info, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return stat.S_ISLNK(info.st_mode) or bool(attrs & reparse)


def _validate_path(path: Path) -> Path:
    """Reject links in every existing component and return the canonical path."""
    absolute = Path(os.path.abspath(os.fspath(path)))
    chain = list(reversed(absolute.parents)) + [absolute]
    for component in chain:
        try:
            info = component.lstat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise GPU_LOCK_INVALID("cannot inspect GPU lease path") from exc
        if _is_reparse_point(info):
            raise GPU_LOCK_INVALID("GPU lease path contains a symbolic link or reparse point")

    root = absolute.parents[2]
    expected_dir = root / "data" / "reconstruction"
    expected_file = expected_dir / "gpu-lease.json"
    try:
        resolved_file = absolute.resolve(strict=False)
        resolved_dir = expected_dir.resolve(strict=False)
        if resolved_file != resolved_dir / "gpu-lease.json":
            raise GPU_LOCK_INVALID("GPU lease resolves outside data/reconstruction")
        resolved_file.relative_to(resolved_dir)
    except (OSError, ValueError) as exc:
        if isinstance(exc, GPU_LOCK_INVALID):
            raise
        raise GPU_LOCK_INVALID("cannot resolve GPU lease path") from exc
    if absolute.name != expected_file.name or absolute.parent != expected_dir:
        raise GPU_LOCK_INVALID("unexpected GPU lease path")
    return absolute


def _read_lease(path: Path) -> tuple[dict, os.stat_result, bytes]:
    try:
        before = path.lstat()
        if _is_reparse_point(before) or not stat.S_ISREG(before.st_mode):
            raise GPU_LOCK_INVALID("GPU lease is not a regular file")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        try:
            opened = os.fstat(fd)
            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                raise GPU_LOCK_INVALID("GPU lease changed while being read")
            chunks = []
            remaining = _MAX_LEASE_BYTES + 1
            while remaining:
                chunk = os.read(fd, min(remaining, 1024))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
        finally:
            os.close(fd)
        raw = b"".join(chunks)
        if len(raw) > _MAX_LEASE_BYTES:
            raise GPU_LOCK_INVALID("GPU lease exceeds 4 KiB")
        after = path.lstat()
        if _is_reparse_point(after) or (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino):
            raise GPU_LOCK_INVALID("GPU lease changed while being read")
        data = json.loads(raw.decode("utf-8"))
    except GPU_LOCK_INVALID:
        raise
    except FileNotFoundError:
        raise
    except (OSError, UnicodeError, ValueError, TypeError) as exc:
        raise GPU_LOCK_INVALID("GPU lease cannot be read or parsed") from exc

    if not isinstance(data, dict):
        raise GPU_LOCK_INVALID("GPU lease must contain a JSON object")
    pid = data.get("pid")
    nonce = data.get("nonce")
    run_id = data.get("runId")
    if (type(data.get("version")) is not int or data["version"] != 1
            or type(pid) is not int or pid <= 0
            or not isinstance(run_id, str) or not _RUN_ID.fullmatch(run_id)
            or not isinstance(nonce, str)):
        raise GPU_LOCK_INVALID("GPU lease fields are invalid")
    try:
        parsed_nonce = uuid.UUID(nonce)
    except (ValueError, AttributeError) as exc:
        raise GPU_LOCK_INVALID("GPU lease nonce is invalid") from exc
    if str(parsed_nonce) != nonce:
        raise GPU_LOCK_INVALID("GPU lease nonce is not canonical")
    return data, before, raw


def _same_file(path: Path, original: os.stat_result) -> bool:
    try:
        current = path.lstat()
    except OSError:
        return False
    return (not _is_reparse_point(current)
            and (current.st_dev, current.st_ino) == (original.st_dev, original.st_ino))


def _windows_pid_is_dead(pid: int, *, kernel32=None, get_last_error=None) -> bool:
    """Check a Windows process using query-only handles; never signal it."""
    from ctypes import wintypes

    if kernel32 is None:
        try:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        except (AttributeError, OSError) as exc:
            raise GPU_LOCK_INVALID("Windows process-query API is unavailable") from exc
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
    if get_last_error is None:
        get_last_error = ctypes.get_last_error

    process_query_limited_information = 0x1000
    error_access_denied = 5
    error_invalid_parameter = 87
    still_active = 259

    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        error = get_last_error()
        if error == error_invalid_parameter:
            return True
        if error == error_access_denied:
            return False
        raise GPU_LOCK_INVALID("cannot determine Windows GPU lease owner liveness")

    try:
        exit_code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            error = get_last_error()
            if error == error_invalid_parameter:
                return True
            if error == error_access_denied:
                return False
            raise GPU_LOCK_INVALID("cannot read Windows GPU lease owner status")
        return exit_code.value != still_active
    finally:
        kernel32.CloseHandle(handle)


def _pid_is_dead(pid: int, *, kernel32=None, get_last_error=None) -> bool:
    if sys.platform == "win32":
        return _windows_pid_is_dead(pid, kernel32=kernel32, get_last_error=get_last_error)
    try:
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return True
        if exc.errno == errno.EPERM:
            return False
        raise GPU_LOCK_INVALID("cannot determine GPU lease owner liveness") from exc


def _unlink_if_same(path: Path, expected_data: dict, expected_stat: os.stat_result, *, strict: bool = True) -> None:
    try:
        current, info, raw = _read_lease(path)
    except FileNotFoundError:
        return
    except GPU_LOCK_INVALID:
        if not strict:
            return
        raise
    if current != expected_data or not _same_file(path, expected_stat):
        if not strict:
            return
        raise GPU_LOCK_INVALID("GPU lease changed before cleanup")
    # Recheck immediately before unlinking so a replaced lease is preserved.
    try:
        current_again, info_again, raw_again = _read_lease(path)
    except FileNotFoundError:
        return
    except GPU_LOCK_INVALID:
        if not strict:
            return
        raise
    if (current_again != expected_data or raw_again != raw
            or (info_again.st_dev, info_again.st_ino) != (info.st_dev, info.st_ino)):
        if not strict:
            return
        raise GPU_LOCK_INVALID("GPU lease changed before cleanup")
    if not _same_file(path, expected_stat):
        if not strict:
            return
        raise GPU_LOCK_INVALID("GPU lease changed before cleanup")
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise GPU_LOCK_INVALID("cannot remove GPU lease") from exc


@contextlib.contextmanager
def reserve_gpu(project_root: Path, run_id: str) -> Iterator[None]:
    """Hold this application's GPU generation lease until the context exits."""
    if not isinstance(run_id, str) or not _RUN_ID.fullmatch(run_id):
        raise ValueError("run_id must match [a-z0-9][a-z0-9-]{0,63}")
    path = _validate_path(_lease_path(Path(project_root)))

    for attempt in range(2):
        lease = {"version": 1, "pid": os.getpid(), "runId": run_id, "nonce": str(uuid.uuid4())}
        payload = json.dumps(lease, separators=(",", ":"), sort_keys=True).encode("utf-8")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(path, flags, 0o600)
        except FileExistsError:
            existing, info, raw = _read_lease(path)
            if not _pid_is_dead(existing["pid"]):
                raise GPU_BUSY("GPU is reserved by another process")
            # Confirm the exact stale lease remains at the fixed path before removal.
            _unlink_if_same(path, existing, info)
            if attempt == 1:
                raise GPU_BUSY("GPU lease changed during stale-lease recovery")
            continue
        except OSError as exc:
            raise GPU_LOCK_INVALID("cannot create GPU lease") from exc

        created_stat = os.fstat(fd)
        try:
            view = memoryview(payload)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("short write while creating GPU lease")
                view = view[written:]
            os.fsync(fd)
        except BaseException:
            os.close(fd)
            if _same_file(path, created_stat):
                try:
                    path.unlink()
                except OSError:
                    pass
            raise
        else:
            os.close(fd)
        break
    else:
        raise GPU_BUSY("could not acquire GPU lease")

    try:
        yield
    finally:
        try:
            _unlink_if_same(path, lease, created_stat, strict=False)
        except FileNotFoundError:
            pass
