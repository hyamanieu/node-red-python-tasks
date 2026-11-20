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
are dispatched to a thread pool, so multiple payloads are processed in
parallel within the same worker process; their responses may arrive out
of order and are correlated by request "id". "define" and "ping" run on
the reader thread, so a "define" always completes before any "call"
that follows it in the input stream.

Threads share the GIL, so the pool parallelizes I/O-bound work (sleeps,
network, subprocesses); CPU-bound parallelism requires multiple worker
processes (a later roadmap phase). The pool size defaults to
min(32, os.cpu_count() + 4) and can be overridden with the
NRPYRUN_WORKER_MAX_THREADS environment variable.
"""

import json
import os
import sys
import traceback
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Any, Optional


PROTOCOL_VERSION = 1


def _max_threads_from_env() -> Optional[int]:
    """Pool size from NRPYRUN_WORKER_MAX_THREADS, or None for the default."""
    raw = os.environ.get("NRPYRUN_WORKER_MAX_THREADS")
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value > 0 else None


class Worker:
    """Main worker class that processes requests."""

    def __init__(self, max_workers: Optional[int] = None):
        self.functions: Dict[str, Dict[str, Any]] = {}  # function_id -> {source, imports, func}
        self.lock = threading.Lock()  # guards self.functions
        self.send_lock = threading.Lock()  # guards stdout writes from pool threads
        self.running = True
        if max_workers is None:
            max_workers = _max_threads_from_env()
        # "call" requests run here, in parallel; everything else runs on
        # the reader thread (see dispatch)
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
            # Import the required modules
            imported_modules = {}
            for module_name in imports:
                try:
                    module = __import__(module_name)
                    imported_modules[module_name] = module
                except ImportError as e:
                    raise ImportError(f"Failed to import {module_name}: {e}")

            # Create the function
            # The source is the body of the function, which should use 'payload' as input
            # We wrap it in a function definition
            func_code = f"def _func(payload):\n"
            # Indent each line of the source
            for line in source.split('\n'):
                func_code += f"    {line}\n"

            # Compile and execute
            local_vars: Dict[str, Any] = {}
            exec(func_code, imported_modules, local_vars)

            if '_func' not in local_vars:
                raise ValueError("Function definition failed")

            func = local_vars['_func']

            # Store the function with its context
            with self.lock:
                self.functions[function_id] = {
                    "source": source,
                    "imports": imports,
                    "func": func,
                    "modules": imported_modules
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
        """Route a request: "call" goes to the thread pool so payloads are
        processed in parallel; the rest run on the reader thread so
        define/ping keep their ordering in the input stream."""
        if request.get("op") == "call":
            self.executor.submit(self._run_request, request)
        else:
            self._run_request(request)

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
            "python": sys.version.split()[0]
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
