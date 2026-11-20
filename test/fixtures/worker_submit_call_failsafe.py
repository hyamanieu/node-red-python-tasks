"""Fail-safe check for sequential mode: submit_call() must run the request
inline even when called directly, bypassing dispatch() (in sequential mode
self.executor is None, so the pool path would crash). Prints the worker's
responses as JSON lines on stdout. PYTHONPATH must point at the package's
python directory (the mocha spec sets it)."""
import io
import os
import sys

os.environ["NRPYRUN_WORKER_MODE"] = "sequential"

from nrpyrun_worker.__main__ import Worker  # noqa: E402

worker = Worker()
assert worker.mode == "sequential", worker.mode
assert worker.executor is None

buf = io.StringIO()
real_stdout = sys.stdout
sys.stdout = buf
try:
    worker.handle_define("d1", {
        "function_id": "f1",
        "source": 'return {"thread": threading.current_thread().name}',
        "imports": ["threading"],
    })
    # bypass dispatch(): this is the path that must not touch self.executor
    worker.submit_call({"id": "c1", "op": "call", "function_id": "f1", "payload": {}})
finally:
    sys.stdout = real_stdout

for line in buf.getvalue().splitlines():
    if line.strip():
        print(line)
