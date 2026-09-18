#!/usr/bin/env python3
"""
Node-RED Python Worker

A persistent Python worker process that executes Python functions
received via JSON-lines protocol on stdin/stdout.

Protocol:
- Request: {"id": "...", "op": "define"|"call"|"ping", ...}
- Response: {"id": "...", "ok": true|"false", "result": ... | "error": {...}}
- Readiness: {"op": "ready", "protocol": 1, "python": "3.x.x"}

The worker is single-threaded and synchronous, processing one request
at a time in order.
"""

import json
import sys
import traceback
import threading
from typing import Dict, Any, Optional


PROTOCOL_VERSION = 1


class Worker:
    """Main worker class that processes requests."""

    def __init__(self):
        self.functions: Dict[str, Dict[str, Any]] = {}  # function_id -> {source, imports, func}
        self.lock = threading.Lock()
        self.running = True

    def send_message(self, message: Dict[str, Any]) -> None:
        """Send a JSON message to stdout."""
        sys.stdout.write(json.dumps(message, default=str) + '\n')
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

        if function_id not in self.functions:
            self.error_response(request_id, ValueError(f"Function {function_id} not defined"))
            return

        try:
            func_info = self.functions[function_id]
            func = func_info["func"]

            # Call the function with the payload
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

    def send_ready(self) -> None:
        """Send the ready message."""
        self.send_message({
            "op": "ready",
            "protocol": PROTOCOL_VERSION,
            "python": sys.version.split()[0]
        })

    def run(self) -> None:
        """Main worker loop."""
        # Send ready message first
        self.send_ready()
        sys.stdout.flush()

        # Read from stdin line by line
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                request = json.loads(line)
                self.process_request(request)
            except json.JSONDecodeError as e:
                # Log to stderr but don't crash
                sys.stderr.write(f"Failed to parse JSON: {e}\n")
            except Exception as e:
                # Log to stderr but don't crash
                sys.stderr.write(f"Error processing request: {e}\n")

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
