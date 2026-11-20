#!/usr/bin/env python3
"""
Node-RED Python Worker

A persistent Python worker process that executes Python functions
received via JSON-lines protocol on stdin/stdout.

Protocol:
- Request: {"id": "...", "op": "define"|"call"|"ping", ...}
- Response: {"id": "...", "ok": true|"false", "result": ... | "error": {...}}
- Readiness: {"op": "ready", "protocol": 1, "python": "3.x.x"}

Requests are read from stdin on a single reader thread. "call" requests
are executed on a pool, so multiple payloads are processed in parallel;
their responses may arrive out of order and are correlated by request
"id". "define" and "ping" run on the reader thread, so a "define" always
completes before any "call" that follows it in the input stream.

The pool matches the interpreter: on a free-threaded build (sysconfig
Py_GIL_DISABLED, e.g. python-freethreading 3.14) it is a
ThreadPoolExecutor, where threads give real parallelism; when the GIL is
active it is a ProcessPoolExecutor (spawn), so CPU-bound payloads run in
parallel across processes. exec'd functions cannot be pickled, so in
process mode each call carries the function source and each pool process
rebuilds and caches it (a definition version propagates redefinitions);
the pool entry point lives in nrpyrun_worker._pool so spawn children can
import it by name. Payloads and results cross the process boundary by
pickle and must be picklable; responses are still JSON-lines, as before.

Pool size: NRPYRUN_WORKER_MAX_THREADS / NRPYRUN_WORKER_MAX_PROCESSES
(defaults: min(32, cpu+4) threads, cpu_count processes).
NRPYRUN_WORKER_MODE=threads|processes forces a mode (default: auto).
"""

import json
import multiprocessing
import os
import sys
import sysconfig
import traceback
import threading
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from typing import Dict, Any, Optional

try:
    from ._pool import build_function, mp_execute
except ImportError:  # executed as a plain script rather than via -m
    from nrpyrun_worker._pool import build_function, mp_execute


PROTOCOL_VERSION = 1


def _is_free_threaded() -> bool:
    """True when the interpreter is a free-threaded (no-GIL) build."""
    try:
        return bool(sysconfig.get_config_var("Py_GIL_DISABLED"))
    except Exception:
        return False


def _resolve_mode() -> str:
    """Execution mode: "threads" on free-threaded builds, "processes" when
    the GIL is active. NRPYRUN_WORKER_MODE=threads|processes forces it."""
    forced = os.environ.get("NRPYRUN_WORKER_MODE", "").strip().lower()
    if forced in ("threads", "processes"):
        return forced
    return "threads" if _is_free_threaded() else "processes"


def _pool_size_from_env(mode: str) -> Optional[int]:
    """Pool size for the given mode from the environment, or the default."""
    if mode == "processes":
        raw = os.environ.get("NRPYRUN_WORKER_MAX_PROCESSES")
        if raw:
            try:
                value = int(raw)
                if value > 0:
                    return value
            except ValueError:
                pass
        return os.cpu_count() or 4
    raw = os.environ.get("NRPYRUN_WORKER_MAX_THREADS")
    if raw:
        try:
            value = int(raw)
            if value > 0:
                return value
        except ValueError:
            pass
    return None  # ThreadPoolExecutor default: min(32, cpu_count + 4)


# build_function and mp_execute live in nrpyrun_worker._pool so that pool
# processes (spawn) can import them by qualified name; an entry point in
# __main__ would not unpickle in the children.


class Worker:
    """Main worker class that processes requests."""

    def __init__(self, max_workers: Optional[int] = None):
        self.functions: Dict[str, Dict[str, Any]] = {}  # function_id -> {source, imports, func, modules, version}
        self.versions: Dict[str, int] = {}  # function_id -> definition version
        self.lock = threading.Lock()  # guards self.functions / self.versions
        self.send_lock = threading.Lock()  # guards stdout writes from pool threads
        self.running = True
        self.free_threaded = _is_free_threaded()
        self.mode = _resolve_mode()
        if max_workers is None:
            max_workers = _pool_size_from_env(self.mode)
        # "call" requests run here, in parallel; everything else runs on
        # the reader thread (see dispatch). Threads when the interpreter is
        # free-threaded, separate processes when the GIL is active.
        if self.mode == "processes":
            self.executor = ProcessPoolExecutor(
                max_workers=max_workers,
                mp_context=multiprocessing.get_context("spawn")
            )
        else:
            self.executor = ThreadPoolExecutor(
                max_workers=max_workers,
                thread_name_prefix="nrpyrun-call"
            )

    def send_message(self, message: Dict[str, Any]) -> None:
        """Send a JSON message to stdout. Safe to call from pool threads."""
        line = json.dumps(message, default=str) + '\n'
        with self.send_lock:
            sys.stdout.write(line)
            sys.stdout.flush()

    def error_response(self, request_id: str, error: Exception) -> None:
        """Send an error response."""
        error_info = {
            "type": type(error).__name__,
            "message": str(error),
            "traceback": traceback.format_exc()
        }
        self.send_message({
            "id": request_id,
            "ok": False,
            "error": error_info
        })

    def success_response(self, request_id: str, result: Any) -> None:
        """Send a success response."""
        # Ensure result is JSON-serializable
        try:
            # Test if result is serializable
            json.dumps(result, default=str)
            self.send_message({
                "id": request_id,
                "ok": True,
                "result": result
            })
        except (TypeError, ValueError) as e:
            self.error_response(request_id, ValueError(f"Result is not JSON-serializable: {e}"))

    def handle_define(self, request_id: str, data: Dict[str, Any]) -> None:
        """Handle a 'define' operation - define a new function."""
        function_id = data.get("function_id")
        source = data.get("source", "")
        imports = data.get("imports", [])

        if not function_id:
            self.error_response(request_id, ValueError("Missing function_id"))
            return

        if not source:
            self.error_response(request_id, ValueError("Missing source"))
            return

        try:
            func, imported_modules = build_function(source, imports)

            # Store the function with its context; the version lets pool
            # processes detect a redefinition and rebuild the function
            with self.lock:
                version = self.versions.get(function_id, 0) + 1
                self.versions[function_id] = version
                self.functions[function_id] = {
                    "source": source,
                    "imports": imports,
                    "func": func,
                    "modules": imported_modules,
                    "version": version
                }

            self.success_response(request_id, None)

        except Exception as e:
            self.error_response(request_id, e)

    def handle_call(self, request_id: str, data: Dict[str, Any]) -> None:
        """Handle a 'call' operation - execute a defined function."""
        function_id = data.get("function_id")
        payload = data.get("payload")

        if not function_id:
            self.error_response(request_id, ValueError("Missing function_id"))
            return

        with self.lock:
            func_info = self.functions.get(function_id)
        if func_info is None:
            self.error_response(request_id, ValueError(f"Function {function_id} not defined"))
            return

        try:
            func = func_info["func"]

            # Call the function with the payload. For "call" ops this runs on
            # a pool thread, so several payloads execute concurrently; the
            # GIL still serializes pure-Python bytecode.
            result = func(payload)

            self.success_response(request_id, result)

        except Exception as e:
            self.error_response(request_id, e)

    def handle_ping(self, request_id: str, data: Dict[str, Any]) -> None:
        """Handle a 'ping' operation - health check."""
        self.success_response(request_id, {"status": "ok"})

    def handle_unknown_op(self, request_id: str, op: str) -> None:
        """Handle an unknown operation."""
        self.error_response(request_id, ValueError(f"Unknown operation: {op}"))

    def process_request(self, request: Dict[str, Any]) -> None:
        """Process a single request."""
        request_id = request.get("id")
        op = request.get("op")

        if not op:
            # Not a request we need to respond to
            return

        if op == "define":
            self.handle_define(request_id, request)
        elif op == "call":
            self.handle_call(request_id, request)
        elif op == "ping":
            self.handle_ping(request_id, request)
        else:
            self.handle_unknown_op(request_id, op)

    def dispatch(self, request: Dict[str, Any]) -> None:
        """Route a request: "call" goes to the execution pool so payloads
        are processed in parallel; the rest run on the reader thread so
        define/ping keep their ordering in the input stream."""
        if request.get("op") == "call":
            self.submit_call(request)
        else:
            self._run_request(request)

    def submit_call(self, request: Dict[str, Any]) -> None:
        """Handle a "call" on the reader thread: validate, then run the
        function on the pool. Threads when free-threaded; with the GIL
        active the call crosses to a pool process together with the
        function source, because exec'd functions cannot be pickled."""
        request_id = request.get("id")
        function_id = request.get("function_id")

        if not function_id:
            self.error_response(request_id, ValueError("Missing function_id"))
            return

        with self.lock:
            info = self.functions.get(function_id)
            if info is None:
                self.error_response(request_id, ValueError(f"Function {function_id} not defined"))
                return
            version = info["version"]
            source = info["source"]
            imports = info["imports"]

        if self.mode == "processes":
            try:
                future = self.executor.submit(
                    mp_execute, function_id, version, source, imports, request.get("payload")
                )
            except Exception as e:
                self.error_response(request_id, e)
                return
            future.add_done_callback(lambda f, rid=request_id: self._finish_process_call(rid, f))
        else:
            self.executor.submit(self._run_request, request)

    def _finish_process_call(self, request_id: str, future) -> None:
        """Send the response for a call executed in a pool process. Runs in
        the executor's callback thread in this process."""
        try:
            try:
                result = future.result()
            except Exception as e:
                self.error_response(request_id, e)
            else:
                self.success_response(request_id, result)
        except Exception as e:
            sys.stderr.write(f"Failed to send process-pool response: {e}\n")

    def _run_request(self, request: Dict[str, Any]) -> None:
        """Process a request on whatever thread it was dispatched to. Never
        let an unexpected error escape without answering the request."""
        try:
            self.process_request(request)
        except Exception as e:
            request_id = request.get("id")
            if request_id is not None:
                try:
                    self.error_response(request_id, e)
                except Exception:
                    sys.stderr.write(f"Failed to send error response: {e}\n")

    def send_ready(self) -> None:
        """Send the ready message."""
        self.send_message({
            "op": "ready",
            "protocol": PROTOCOL_VERSION,
            "python": sys.version.split()[0],
            "free_threaded": self.free_threaded,
            "mode": self.mode
        })

    def run(self) -> None:
        """Main worker loop: read requests from stdin and dispatch them."""
        # Send ready message first
        self.send_ready()

        # Read from stdin line by line
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                request = json.loads(line)
            except json.JSONDecodeError as e:
                # Log to stderr but don't crash
                sys.stderr.write(f"Failed to parse JSON: {e}\n")
                continue

            try:
                self.dispatch(request)
            except Exception as e:
                # Log to stderr but don't crash
                sys.stderr.write(f"Error dispatching request: {e}\n")

        # stdin closed: wait for in-flight calls so their responses are
        # written before the process exits
        self.executor.shutdown(wait=True)

    def stop(self) -> None:
        """Stop the worker."""
        self.running = False


def main():
    """Entry point for the worker."""
    worker = Worker()
    
    try:
        worker.run()
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception as e:
        sys.stderr.write(f"Worker crashed: {e}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
