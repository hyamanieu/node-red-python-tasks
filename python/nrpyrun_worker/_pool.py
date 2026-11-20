"""Pool-process support for the worker (multiprocessing mode).

This module must be importable by its qualified name (nrpyrun_worker._pool):
with the spawn start method, pool processes unpickle the task entry point
by module + qualname, and a function defined in __main__ does not resolve
in the child (when the worker runs via `python -m nrpyrun_worker`, the
child's __main__ is the multiprocessing bootstrap, not our module).
"""

import threading
from typing import Any, Dict


def build_function(source: str, imports: list):
    """Import the requested modules and compile the source into a callable.
    Returns (func, imported_modules). Used by the worker process on
    'define' and by pool processes to (re)build functions on 'call'."""
    imported_modules = {}
    for module_name in imports:
        try:
            imported_modules[module_name] = __import__(module_name)
        except ImportError as e:
            raise ImportError(f"Failed to import {module_name}: {e}")

    # The source is the body of the function, which should use 'payload' as
    # input; wrap it in a function definition and indent each line
    func_code = "def _func(payload):\n"
    for line in source.split('\n'):
        func_code += f"    {line}\n"

    # Compile and execute
    local_vars: Dict[str, Any] = {}
    exec(func_code, imported_modules, local_vars)

    if '_func' not in local_vars:
        raise ValueError("Function definition failed")

    return local_vars['_func'], imported_modules


# --- pool-process state ---
# Each pool process rebuilds the defined functions from their source and
# caches them; the definition version detects redefinitions.
_mp_functions: Dict[str, Any] = {}
_mp_lock = threading.Lock()


def mp_execute(function_id: str, version: int, source: str, imports: list, payload: Any) -> Any:
    """Entry point executed inside a pool process: run the defined function
    with the payload and return the result (must be picklable)."""
    with _mp_lock:
        entry = _mp_functions.get(function_id)
        if entry is None or entry[0] != version:
            func, _ = build_function(source, imports)
            entry = (version, func)
            _mp_functions[function_id] = entry
    return entry[1](payload)
