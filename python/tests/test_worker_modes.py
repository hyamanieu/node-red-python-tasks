"""Unit tests for the pure in-process parts of nrpyrun_worker.__main__:
execution-mode resolution, pool sizing, and in-process request dispatch.

These run with the stdlib unittest runner, no extra dependencies:
    PYTHONPATH=python python3 -m unittest discover -s python/tests -v
In CI / `npm test` they are launched by scripts/run-python-tests.js.
The process-boundary behaviour (spawn pools, JSON-lines over stdio) is
covered by the mocha suite in test/lib/worker_modes_spec.js, which spawns
the real worker process.
"""

import contextlib
import io
import json
import os
import sys
import sysconfig
import unittest
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from unittest import mock

import nrpyrun_worker.__main__ as wm

MODE_ENV_VARS = (
    "NRPYRUN_WORKER_MODE",
    "NRPYRUN_WORKER_MAX_THREADS",
    "NRPYRUN_WORKER_MAX_PROCESSES",
)


@contextlib.contextmanager
def env(**overrides):
    """Run with a clean worker env plus the given overrides; the real
    environment is restored afterwards."""
    with mock.patch.dict(os.environ):
        for name in MODE_ENV_VARS:
            os.environ.pop(name, None)
        os.environ.update(overrides)
        yield


def read_messages(buf):
    return [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]


class ResolveModeTest(unittest.TestCase):
    def test_forced_modes_are_honoured(self):
        for mode in ("threads", "processes", "sequential"):
            with env(NRPYRUN_WORKER_MODE=mode):
                self.assertEqual(wm._resolve_mode(), mode)

    def test_forced_mode_is_case_and_whitespace_insensitive(self):
        with env(NRPYRUN_WORKER_MODE="  Threads "):
            self.assertEqual(wm._resolve_mode(), "threads")

    def test_unknown_forced_value_falls_back_to_auto(self):
        with env(NRPYRUN_WORKER_MODE="bogus"):
            expected = "threads" if wm._is_free_threaded() else "processes"
            self.assertEqual(wm._resolve_mode(), expected)

    def test_auto_is_threads_on_free_threaded_builds_processes_otherwise(self):
        with env():
            expected = "threads" if wm._is_free_threaded() else "processes"
            self.assertEqual(wm._resolve_mode(), expected)

    def test_is_free_threaded_matches_sysconfig(self):
        self.assertEqual(
            wm._is_free_threaded(),
            bool(sysconfig.get_config_var("Py_GIL_DISABLED")),
        )


class PoolSizeFromEnvTest(unittest.TestCase):
    def test_sequential_mode_has_no_pool_size(self):
        with env():
            self.assertIsNone(wm._pool_size_from_env("sequential"))

    def test_processes_default_is_cpu_count(self):
        with env():
            self.assertEqual(wm._pool_size_from_env("processes"), os.cpu_count() or 4)

    def test_processes_size_from_env(self):
        with env(NRPYRUN_WORKER_MAX_PROCESSES="7"):
            self.assertEqual(wm._pool_size_from_env("processes"), 7)

    def test_processes_ignores_invalid_sizes(self):
        for raw in ("0", "-3", "abc"):
            with env(NRPYRUN_WORKER_MAX_PROCESSES=raw):
                self.assertEqual(wm._pool_size_from_env("processes"), os.cpu_count() or 4)

    def test_threads_default_is_none_so_the_executor_default_applies(self):
        with env():
            self.assertIsNone(wm._pool_size_from_env("threads"))

    def test_threads_size_from_env(self):
        with env(NRPYRUN_WORKER_MAX_THREADS="5"):
            self.assertEqual(wm._pool_size_from_env("threads"), 5)

    def test_threads_ignores_invalid_sizes(self):
        for raw in ("0", "-1", "abc"):
            with env(NRPYRUN_WORKER_MAX_THREADS=raw):
                self.assertIsNone(wm._pool_size_from_env("threads"))


class WorkerConstructionTest(unittest.TestCase):
    def test_sequential_mode_has_no_executor(self):
        with env(NRPYRUN_WORKER_MODE="sequential"):
            worker = wm.Worker()
        self.assertEqual(worker.mode, "sequential")
        self.assertIsNone(worker.executor)

    def test_threads_mode_uses_a_thread_pool(self):
        with env(NRPYRUN_WORKER_MODE="threads"):
            worker = wm.Worker(max_workers=3)
        self.addCleanup(worker.executor.shutdown, wait=False)
        self.assertIsInstance(worker.executor, ThreadPoolExecutor)
        self.assertEqual(worker.executor._max_workers, 3)

    def test_processes_mode_uses_a_spawn_process_pool(self):
        with env(NRPYRUN_WORKER_MODE="processes"):
            worker = wm.Worker()
        self.addCleanup(worker.executor.shutdown, wait=False)
        self.assertIsInstance(worker.executor, ProcessPoolExecutor)


class ReadyMessageTest(unittest.TestCase):
    def test_ready_message_reports_protocol_mode_and_interpreter(self):
        with env(NRPYRUN_WORKER_MODE="sequential"):
            worker = wm.Worker()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            worker.send_ready()
        msg = json.loads(buf.getvalue().strip())
        self.assertEqual(msg["op"], "ready")
        self.assertEqual(msg["protocol"], wm.PROTOCOL_VERSION)
        self.assertEqual(msg["mode"], "sequential")
        self.assertEqual(msg["free_threaded"], wm._is_free_threaded())
        self.assertEqual(msg["python"], sys.version.split()[0])


class DispatchTest(unittest.TestCase):
    """In sequential mode every request runs inline on the calling thread,
    so responses appear synchronously and in input order."""

    def test_sequential_mode_runs_define_and_call_inline_in_order(self):
        with env(NRPYRUN_WORKER_MODE="sequential"):
            worker = wm.Worker()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            worker.dispatch({"id": "d1", "op": "define", "function_id": "f1",
                             "source": "return {'thread': threading.current_thread().name}",
                             "imports": ["threading"]})
            worker.dispatch({"id": "c1", "op": "call", "function_id": "f1", "payload": {}})
            # fail-safe: submit_call reached directly must also run inline
            worker.submit_call({"id": "c2", "op": "call", "function_id": "f1", "payload": {}})
        messages = read_messages(buf)
        self.assertEqual([m["id"] for m in messages], ["d1", "c1", "c2"])
        by_id = {m["id"]: m for m in messages}
        self.assertTrue(by_id["d1"]["ok"])
        self.assertTrue(by_id["c1"]["ok"])
        self.assertEqual(by_id["c1"]["result"]["thread"], "MainThread")
        self.assertTrue(by_id["c2"]["ok"])

    def test_non_call_ops_run_inline_even_in_pool_modes(self):
        with env(NRPYRUN_WORKER_MODE="threads"):
            worker = wm.Worker()
        self.addCleanup(worker.executor.shutdown, wait=False)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            worker.dispatch({"id": "p1", "op": "ping"})
        self.assertEqual(read_messages(buf),
                         [{"id": "p1", "ok": True, "result": {"status": "ok"}}])

    def test_redefine_bumps_the_definition_version(self):
        with env(NRPYRUN_WORKER_MODE="sequential"):
            worker = wm.Worker()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            worker.dispatch({"id": "d1", "op": "define", "function_id": "f",
                             "source": "return 1", "imports": []})
            worker.dispatch({"id": "d2", "op": "define", "function_id": "f",
                             "source": "return 2", "imports": []})
        self.assertEqual(worker.versions["f"], 2)
        by_id = {m["id"]: m for m in read_messages(buf)}
        self.assertTrue(by_id["d1"]["ok"])
        self.assertTrue(by_id["d2"]["ok"])

    def test_bad_requests_get_error_responses_not_exceptions(self):
        with env(NRPYRUN_WORKER_MODE="sequential"):
            worker = wm.Worker()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            worker.dispatch({"id": "u1", "op": "bogus"})
            worker.dispatch({"id": "c1", "op": "call", "function_id": "missing", "payload": {}})
            worker.dispatch({"id": "d1", "op": "define", "function_id": "f", "source": ""})
            worker.dispatch({"id": "d2", "op": "define", "function_id": "f",
                             "source": "return 1", "imports": ["no_such_module_xyz_123"]})
        by_id = {m["id"]: m for m in read_messages(buf)}
        for rid in ("u1", "c1", "d1", "d2"):
            self.assertFalse(by_id[rid]["ok"], rid)
            self.assertIn("message", by_id[rid]["error"], rid)
        self.assertIn("Unknown operation", by_id["u1"]["error"]["message"])
        self.assertIn("not defined", by_id["c1"]["error"]["message"])
        self.assertIn("Missing source", by_id["d1"]["error"]["message"])
        self.assertEqual(by_id["d2"]["error"]["type"], "ImportError")


if __name__ == "__main__":
    unittest.main()
