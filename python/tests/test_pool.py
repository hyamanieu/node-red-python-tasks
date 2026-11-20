"""Unit tests for nrpyrun_worker._pool (pure in-process logic).

These run with the stdlib unittest runner, no extra dependencies:
    PYTHONPATH=python python3 -m unittest discover -s python/tests -v
In CI / `npm test` they are launched by scripts/run-python-tests.js.
The process-boundary behaviour (spawn pools, JSON-lines over stdio) is
covered by the mocha suite in test/lib/worker_modes_spec.js, which spawns
the real worker process.
"""

import unittest

from nrpyrun_worker import _pool
from nrpyrun_worker._pool import build_function, mp_execute


class BuildFunctionTest(unittest.TestCase):
    def test_wraps_source_as_a_callable_taking_payload(self):
        func, modules = build_function("return payload * 2", [])
        self.assertEqual(func(21), 42)
        # exec injects __builtins__ into the globals dict; no imports requested
        self.assertEqual(set(modules), {"__builtins__"})

    def test_requested_imports_are_available_in_the_function(self):
        func, modules = build_function("return math.sqrt(payload)", ["math"])
        self.assertEqual(func(16), 4.0)
        self.assertIn("math", modules)

    def test_unknown_import_raises_import_error(self):
        with self.assertRaises(ImportError):
            build_function("return payload", ["no_such_module_xyz_123"])

    def test_syntax_error_in_source_raises_at_define_time(self):
        with self.assertRaises(SyntaxError):
            build_function("x = = 3", [])

    def test_runtime_error_surfaces_at_call_time_not_define_time(self):
        func, _ = build_function("return 1 / 0", [])
        with self.assertRaises(ZeroDivisionError):
            func(None)


class MpExecuteTest(unittest.TestCase):
    """mp_execute is the entry point pool processes unpickle by name; it
    rebuilds a function from source when the definition version changes
    and caches it otherwise."""

    def setUp(self):
        _pool._mp_functions.clear()

    def tearDown(self):
        _pool._mp_functions.clear()

    def test_runs_the_function_and_caches_it_by_version(self):
        self.assertEqual(mp_execute("f", 1, "return payload + 1", [], 41), 42)
        self.assertIn("f", _pool._mp_functions)
        self.assertEqual(_pool._mp_functions["f"][0], 1)

    def test_same_version_reuses_the_cached_function_object(self):
        mp_execute("f", 1, "return payload + 1", [], 1)
        cached = _pool._mp_functions["f"][1]
        self.assertEqual(mp_execute("f", 1, "return payload + 1", [], 2), 3)
        self.assertIs(_pool._mp_functions["f"][1], cached)

    def test_new_version_rebuilds_the_function(self):
        mp_execute("f", 1, "return payload + 1", [], 1)
        old = _pool._mp_functions["f"][1]
        self.assertEqual(mp_execute("f", 2, "return payload * 10", [], 3), 30)
        self.assertEqual(_pool._mp_functions["f"][0], 2)
        self.assertIsNot(_pool._mp_functions["f"][1], old)

    def test_imports_are_available_in_the_rebuilt_function(self):
        self.assertEqual(mp_execute("g", 1, "return math.floor(payload)", ["math"], 3.7), 3)

    def test_function_exception_propagates_to_the_caller(self):
        with self.assertRaises(ZeroDivisionError):
            mp_execute("h", 1, "return 1 / 0", [], None)


if __name__ == "__main__":
    unittest.main()
