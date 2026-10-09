import json
import os
import sys
import unittest
import uuid
from pathlib import Path
from unittest import mock

import gpu_reservation


def project_root() -> Path:
    root = Path(__file__).resolve().parents[2] / "data" / "gpu-reservation-tests" / uuid.uuid4().hex
    (root / "data" / "reconstruction").mkdir(parents=True, exist_ok=True)
    return root


def lease_path(root: Path) -> Path:
    return root / "data" / "reconstruction" / "gpu-lease.json"


class GPUReservationTests(unittest.TestCase):
    def test_run_id_rejects_path_injection_before_touching_lease(self):
        root = project_root()
        path = lease_path(root)
        for run_id in ("../escape", "Upper", "", "x" * 65):
            with self.subTest(run_id=run_id):
                with self.assertRaises(ValueError):
                    with gpu_reservation.reserve_gpu(root, run_id):
                        pass
                self.assertFalse(path.exists())

    def test_lease_is_removed_after_normal_and_exceptional_exit(self):
        root = project_root()
        path = lease_path(root)
        with gpu_reservation.reserve_gpu(root, "normal-run"):
            lease = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(lease["version"], 1)
            self.assertEqual(lease["pid"], os.getpid())
            self.assertEqual(lease["runId"], "normal-run")
            uuid.UUID(lease["nonce"])
        self.assertFalse(path.exists())

        with self.assertRaises(RuntimeError):
            with gpu_reservation.reserve_gpu(root, "exception-run"):
                raise RuntimeError("generator failed")
        self.assertFalse(path.exists())

    def test_existing_live_lease_is_busy_and_unchanged(self):
        root = project_root()
        path = lease_path(root)
        raw = json.dumps({"version": 1, "pid": os.getpid(), "runId": "owner", "nonce": str(uuid.uuid4())}).encode()
        path.write_bytes(raw)
        with mock.patch.object(gpu_reservation.os, "kill", return_value=None):
            with self.assertRaises(gpu_reservation.GPU_BUSY):
                with gpu_reservation.reserve_gpu(root, "contender"):
                    pass
        self.assertEqual(path.read_bytes(), raw)

    def test_dead_pid_is_removed_and_retried(self):
        root = project_root()
        path = lease_path(root)
        path.write_text(json.dumps({"version": 1, "pid": 424242, "runId": "stale", "nonce": str(uuid.uuid4())}), encoding="utf-8")
        real_kill = os.kill
        calls = []

        def kill(pid, sig):
            calls.append(pid)
            if pid == 424242:
                raise ProcessLookupError()
            return real_kill(pid, sig)

        with mock.patch.object(sys, "platform", "linux"), mock.patch.object(gpu_reservation.os, "kill", side_effect=kill):
            with gpu_reservation.reserve_gpu(root, "recovered"):
                self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["runId"], "recovered")
        self.assertEqual(calls.count(424242), 1)
        self.assertFalse(path.exists())

    def test_access_denied_is_busy_and_preserved(self):
        root = project_root()
        path = lease_path(root)
        raw = json.dumps({"version": 1, "pid": 9876, "runId": "owner", "nonce": str(uuid.uuid4())}).encode()
        path.write_bytes(raw)
        with mock.patch.object(sys, "platform", "linux"), mock.patch.object(gpu_reservation.os, "kill", side_effect=PermissionError()):
            with self.assertRaises(gpu_reservation.GPU_BUSY):
                with gpu_reservation.reserve_gpu(root, "contender"):
                    pass
        self.assertEqual(path.read_bytes(), raw)

    def test_windows_probe_uses_query_api_and_never_os_kill(self):
        from ctypes import wintypes

        class Kernel32:
            def __init__(self):
                self.open_args = None
                self.closed = []

            def OpenProcess(self, access, inherit, pid):
                self.open_args = (access, inherit, pid)
                return 123

            def GetExitCodeProcess(self, handle, code):
                code._obj.value = 259
                return 1

            def CloseHandle(self, handle):
                self.closed.append(handle)
                return 1

        kernel = Kernel32()
        with mock.patch.object(sys, "platform", "win32"):
            with mock.patch.object(gpu_reservation.os, "kill", side_effect=AssertionError("must not signal on Windows")):
                self.assertFalse(gpu_reservation._pid_is_dead(777, kernel32=kernel, get_last_error=lambda: 0))
        self.assertEqual(kernel.open_args, (0x1000, False, 777))
        self.assertEqual(kernel.closed, [123])

    def test_windows_probe_treats_missing_pid_as_dead_and_access_denied_as_busy(self):
        class Kernel32:
            def OpenProcess(self, access, inherit, pid):
                return 0

        with mock.patch.object(sys, "platform", "win32"):
            self.assertTrue(gpu_reservation._pid_is_dead(777, kernel32=Kernel32(), get_last_error=lambda: 87))
            self.assertFalse(gpu_reservation._pid_is_dead(777, kernel32=Kernel32(), get_last_error=lambda: 5))

    def test_current_process_probe_is_read_only_and_reports_alive(self):
        self.assertFalse(gpu_reservation._pid_is_dead(os.getpid()))

    def test_invalid_leases_are_not_deleted(self):
        examples = [
            b"not json",
            b"{}",
            json.dumps({"version": 1, "pid": 1, "runId": "ok", "nonce": "not-a-uuid"}).encode(),
        ]
        for content in examples:
            with self.subTest(content=content):
                root = project_root()
                path = lease_path(root)
                path.write_bytes(content)
                with self.assertRaises(gpu_reservation.GPU_LOCK_INVALID):
                    with gpu_reservation.reserve_gpu(root, "contender"):
                        pass
                self.assertEqual(path.read_bytes(), content)

    def test_exit_does_not_unlink_replaced_lease(self):
        root = project_root()
        path = lease_path(root)
        with gpu_reservation.reserve_gpu(root, "owner"):
            replacement = {"version": 1, "pid": os.getpid(), "runId": "replacement", "nonce": str(uuid.uuid4())}
            path.write_text(json.dumps(replacement), encoding="utf-8")
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), replacement)

    def test_symlinked_parent_is_rejected(self):
        root = project_root()
        parent = root / "data" / "reconstruction"
        actual = root / "data" / "elsewhere"
        actual.mkdir(parents=True, exist_ok=True)
        parent.rmdir()
        try:
            parent.symlink_to(actual, target_is_directory=True)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"directory symlink unavailable: {exc}")
        with self.assertRaises(gpu_reservation.GPU_LOCK_INVALID):
            with gpu_reservation.reserve_gpu(root, "symlink-case"):
                pass

    def test_resolved_path_must_remain_in_reconstruction_dir(self):
        root = project_root()
        outside = root / "data" / "escaped.json"
        with mock.patch.object(gpu_reservation, "_lease_path", return_value=outside, create=True):
            with self.assertRaises(gpu_reservation.GPU_LOCK_INVALID):
                with gpu_reservation.reserve_gpu(root, "outside-case"):
                    pass


if __name__ == "__main__":
    unittest.main()
