# Task brief: MVP (Phase 1 — local execution)

**Audience:** coding agent. Humans should read [README.md](../../README.md) and
[ROADMAP.md](../../ROADMAP.md) instead; this file is an implementation contract, not documentation.

**Prerequisite reading:** [AGENTS.md](../../AGENTS.md), then `ROADMAP.md` (for what is in scope and
what belongs to a later phase). Note that Phase 0 (development environment) must be completed first,
as development and testing run entirely in containers. Do not implement anything listed under Phase 2 or later.

## Objective

Deliver a working, installable Node-RED package that lets a user call a Python function from a flow.
The Python process must persist between messages, and the environment must be managed by pixi.

Success is a package a user can install into `~/.node-red`, configure against a `pixi.toml`, and use
in a flow — not a prototype script.

## Terminology rule

User-facing strings (node type names, labels, editor help, error messages, status text) refer to
**Python environments**, never "pixi-*" — that is why the config node is `python-workspace`. Users
must not *need* to know pixi is used under the hood, but documentation (README "how it works",
install prerequisites) may name it where it helps. The one naming exception: a field whose value is
literally a path to a `pixi.toml` may name the file. Internal identifiers, code comments and this
document may name pixi freely.

## Scope

### In scope

1. `python-workspace` configuration node — defines a Python environment by listing dependencies with version
   specifications (e.g., `["python=3.9", "numpy=1"]`). The node internally manages a pixi project and
   environment. Users do not need access to the Node-RED hosting machine's filesystem.
2. `python-function` node — references a `python-workspace` and stores a Python function body as text; executed
   via a persistent worker process per `python-workspace` instance using a JSON-lines protocol. The worker is
   a synchronous, single-threaded loop — one request from a given environment is fully processed
   before the next begins. No asyncio, no thread pool, no concurrent execution within one worker.
3. `python-run` node — references a `python-workspace` and stores a command name (and optionally fixed
   arguments); executed as one process per invocation via `pixi run -e <environment> -x <command>
   [args...]`, using pixi's `-x`/`--executable` flag so the command is executed directly rather than
   resolved as a pixi.toml task.
4. A persistent Python worker process per `python-workspace` instance, launched via pixi, shared by all
   `python-function` nodes referencing that environment.
5. A JSON-lines request/response protocol over the worker's stdin/stdout, with correlation IDs.
6. Error propagation: Python exceptions (`python-function`) and non-zero exit codes (`python-run`)
   produce Node-RED errors catchable by a `catch` node.
7. Worker supervision: crash detection, restart with exponential backoff, node status reflecting the
   real state.
8. Tests and CI.

### Explicitly out of scope

Do not implement, and do not add configuration fields in anticipation of:

- Containerised or remote execution (Phases 3 and 5).
- Direct TOML file editing in the node UI (Phase 2).
- Input/output schema validation (Phase 2).
- Multiple workers per environment, or any concurrency beyond what one worker provides (Phase 2).
- Streaming or generator support (Phase 2).
- Binary or non-JSON payload optimisation (Phase 2).
- File-path or `module:function` reference options.

If a requirement below seems to need one of these, stop and raise it rather than implementing it.

## Interface specification

### `python-workspace` (configuration node)

Type name: `python-workspace`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | no | Display label |
| `dependencies` | string[] | yes | Package specifications with versions (e.g., `["python=3.9", "numpy=1"]`) |
| `environment` | string | no | pixi environment name, default `default` |
| `startupTimeout` | number | no | Milliseconds to wait for worker readiness, default `120000` |

Behaviour:

- On deploy, the node internally creates or updates a persistent pixi workspace with the specified
  dependencies: `pixi init` for a new workspace, then `pixi add` so the installed environment converges
  to the dependency list. Each environment (config node) owns one workspace folder, named after the
  environment's user-given `name`, which survives restarts and redeploys. The workspaces on disk are
  the source of truth: at startup (before flows are loaded) each workspace folder is reconciled into
  the flow file so it is represented exactly once as a `python-workspace` config node, even if the host
  was recreated and the flow file lost the nodes.
- Install/resolve the environment (`pixi install`) before launching the worker. This can be slow on
  first run; the startup timeout must accommodate it.
- Launch exactly one worker process, lazily on first use or at deploy time (implementer's choice —
  document which).
- Shut the worker down cleanly on node close and on redeploy. No orphaned processes.
- Deleting the config node is definitive: on `close` with `removed=true`, the node deletes the
  workspace folder it owns (guarded by the workspace metadata's node id), so the environment is
  not resurrected by startup reconciliation. Redeploy/restart (`removed=false`) keeps the
  folder.
- Users do not need filesystem access to the Node-RED host; everything is managed internally.

### `python-function` (execution node)

Type name: `python-function`. One input, one output.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | no | Display label |
| `workspace` | config node ref | yes | The `python-workspace` to run in |
| `functionBody` | string | yes | Python code (function body only, not a full `def` statement) that uses `payload` as the input argument |
| `imports` | string[] | no | Module names to pre-import (e.g., `["numpy", "pandas"]`); available in `functionBody` without explicit import |
| `timeout` | number | no | Per-call timeout in ms, default `30000`; `0` disables |

Behaviour:

- On first use or when the function body or imports change: send a `define` op to the worker with the
  `functionBody` source and `imports` list. The worker pre-loads the specified modules.
- On message: send `msg.payload` to the persistent worker. The `functionBody` code is executed with
  `payload` set to `msg.payload`. Modules listed in `imports` are already loaded and available. On success,
  set `msg.payload` to the return value and send on output 1. All other `msg` properties are preserved.
- On Python exception: call `node.error(err, msg)` so a `catch` node can handle it. The error object
  carries `type`, `message` and `traceback` from Python. Nothing is sent on the output.
- On timeout: same as an exception, with a distinguishable error type. The in-flight request is
  abandoned; consider whether the worker must be restarted and document the decision.
- Node status reflects reality: environment installing / worker starting / ready / running / error.

Execution path: Uses the persistent worker process per `python-workspace` and the JSON-lines protocol.
The worker is a synchronous, single-threaded loop — one request from a given environment is fully
processed before the next begins. Two messages sent to the same `python-workspace` in quick succession are
processed strictly in order, and the second one's latency includes waiting for the first to finish.

### `python-run` (execution node)

Type name: `python-run`. One input, one output.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | no | Display label |
| `workspace` | config node ref | yes | The `python-workspace` to run in |
| `command` | string | yes | Command name to execute |
| `args` | string[] | no | Fixed arguments prepended to payload arguments |
| `timeout` | number | no | Per-call timeout in ms, default `30000`; `0` disables |

Behaviour:

- On message: execute `pixi run -e <environment> -x <command> [args...]` where `<environment>` is the
  pixi environment name from the `python-workspace` config node. The command is resolved on the environment's
  PATH via pixi's `-x`/`--executable` flag.
- Payload-to-argv mapping: if `msg.payload` is an array, its elements become positional arguments
  (stringified) appended to the fixed `args`; if `msg.payload` is an object, it is passed as a single
  JSON string argument, and the invoked command is responsible for parsing it. This is a fixed
  convention, not an implementer choice.
- On success: `msg.payload` is set to the captured stdout (trimmed) and sent on output 1. All other
  `msg` properties are preserved.
- On non-zero exit status: call `node.error(err, msg)` so a `catch` node can handle it. The error
  carries the exit code. Nothing is sent on the output.
- On timeout: same as an exception, with a distinguishable error type.
- Node status reflects reality: environment installing / ready / running / error.

Execution path: One process per invocation. No persistent worker is used for this node.

## Wire protocol

JSON Lines (one compact JSON object per line, UTF-8, `\n`-terminated) over the worker's stdin and
stdout. The worker's stderr is not part of the protocol and is forwarded to the Node-RED log.

This protocol is transport-agnostic on purpose: Phase 3 replaces stdio with a socket without
changing message shapes. Do not embed stdio-specific assumptions in the message format.

Request (Node-RED → worker):

```json
{"id": "a1b2c3", "op": "call", "function_id": "func_abc123", "payload": {}}
```

Also required: `{"id": "...", "op": "ping"}` for health checks.

On first use of a function body, a `define` operation is sent before `call`:

```json
{"id": "d1e2f3", "op": "define", "function_id": "func_abc123", "source": "return numpy.mean(payload)", "imports": ["numpy"]}
```

Success response (worker → Node-RED):

```json
{"id": "a1b2c3", "ok": true, "result": {}}
```

Error response:

```json
{"id": "a1b2c3", "ok": false, "error": {"type": "ValueError", "message": "...", "traceback": "..."}}
```

Readiness, emitted once on start-up before any response:

```json
{"op": "ready", "protocol": 1, "python": "3.12.3"}
```

Rules:

- `id` is generated by the Node-RED side and echoed verbatim. Responses are returned in the same
  order as requests are processed (the worker is single-threaded and synchronous).
- The worker receives function definitions via `define` op (with `source` and `imports`) and caches them
  by `function_id`. A `call` op references a previously defined `function_id`.
- The worker pre-imports modules listed in `imports` before caching the function, making them available
  in the function body without explicit import statements.
- A payload that cannot be JSON-serialised is an error response, not a crash.
- Unknown `op` values produce an error response, not a crash. Never let a malformed line kill the
  worker.

## Repository layout

Create this structure. Files marked `(exists)` are already present.

```
.
├── AGENTS.md                  (exists)
├── README.md                  (exists)
├── ROADMAP.md                 (exists)
├── CONTRIBUTING.md
├── LICENSE                     MIT
├── package.json                the "node-red" key maps node types to their .js files
├── nodes/
│   ├── python-workspace.js           runtime: config node, environment + worker lifecycle
│   ├── python-workspace.html         editor: edit dialog and help
│   ├── python-function.js      runtime: execution node (function body)
│   ├── python-function.html    editor: edit dialog and help
│   ├── python-run.js           runtime: execution node (command)
│   └── python-run.html         editor: edit dialog and help
├── lib/
│   ├── worker.js               spawn, supervise, restart the worker process
│   └── protocol.js             framing, correlation IDs, pending-request table
├── python/
│   └── nrpyrun_worker/
│       ├── __init__.py
│       └── __main__.py         the worker loop
├── test/
│   ├── python-workspace_spec.js
│   ├── python-function_spec.js
│   └── fixtures/
│       └── pixi-project/       minimal pixi.toml + a module with test functions
├── examples/
│   └── basic.json              importable example flow
└── docs/
    └── agent/
        └── MVP.md              (this file)
```

Conventions:

- Node-RED requires each node's runtime `.js` and editor `.html` to share a base name.
- The worker is launched as `pixi run -e <environment> python -m nrpyrun_worker`, with the
  `python/` directory on `PYTHONPATH`. Do not require the user to install the worker package.
- Node.js 18+. CommonJS, matching Node-RED conventions.
- No new runtime npm dependencies without justification in the PR description.

## Acceptance criteria

The task is complete when all of the following hold:

1. `npm install` in a `~/.node-red` directory installs the package and all three nodes appear in the
   palette under a `python` category (`python-workspace`, `python-function`, `python-run`).
2. A flow with `inject → python-function → debug`, configured against the test fixture project,
   returns the function's result.
3. The Python worker process is started once: calling `python-function` 1000 times spawns
   exactly one worker process, verifiable in the logs.
4. Throughput of at least 200 messages/second for a trivial function on ordinary hardware.
5. Raising an exception in the Python function triggers a `catch` node, and the error
   carries type, message and traceback.
6. Killing the worker process externally causes an automatic restart, and the next message succeeds.
7. Redeploying the flow leaves no orphaned Python processes.
8. A `python-workspace` with invalid dependency specifications produces a clear error at deploy time, not a
   stack trace at first message.
9. `npm test` passes; tests use `node-red-node-test-helper` and cover success, exception, timeout,
   worker restart and malformed-payload paths for both `python-function` and `python-run`.
10. All `.html` files contain editor help text explaining each field in user-facing terms (see the
    terminology rule).
11. A nonzero exit status from a `python-run` invocation is catchable as a Node-RED error via a
    `catch` node.
12. A `python-function` that uses `payload` as input and imports a pixi-installed package resolves and executes correctly.
13. Two messages sent to the same `python-workspace` in quick succession via `python-function` are processed
    strictly in order, and the second one's latency includes waiting for the first to finish.

## Working agreement

- Implement in this order: protocol and worker (`python/`, `lib/`) → config node → execution nodes
  (`python-function`, `python-run`) → editor UI → tests. The Python worker can be developed and
  tested standalone first.
- Commit in logical units with meaningful messages. Do not squash the whole MVP into one commit.
- When a decision is left to the implementer above, record it in the PR description and, if it
  affects users, in the node's help text.
- If a requirement here conflicts with `ROADMAP.md` or `AGENTS.md`, stop and ask. Do not resolve the
  conflict unilaterally.
