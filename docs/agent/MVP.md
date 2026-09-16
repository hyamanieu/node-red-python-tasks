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

User-facing strings (node labels, editor help, error messages, status text) refer to **Python
environments**. They do not mention pixi. Internal identifiers, code comments and this document may.
The one exception: a field whose value is literally a path to a `pixi.toml` may name the file.

## Scope

### In scope

1. `python-env` configuration node — holds the path to a directory containing a `pixi.toml`, and the
   name of the pixi environment to use (default: `default`).
2. `python-function` node — references a `python-env`, plus a target callable specified as
   `module:function`, plus a working directory added to `sys.path`.
3. A persistent Python worker process per `python-env` instance, launched via pixi, shared by all
   `python-function` nodes referencing that environment.
4. A JSON-lines request/response protocol over the worker's stdin/stdout, with correlation IDs.
5. Error propagation: a Python exception produces a Node-RED error catchable by a `catch` node.
6. Worker supervision: crash detection, restart with exponential backoff, node status reflecting the
   real state.
7. Tests and CI.

### Explicitly out of scope

Do not implement, and do not add configuration fields in anticipation of:

- Containerised or remote execution (Phases 3 and 5).
- Generating `pixi.toml` from a dependency list (Phase 2). The MVP requires an existing file.
- Inline Python source in the node (Phase 2).
- Input/output schema validation (Phase 2).
- Multiple workers per environment, or any concurrency beyond what one worker provides (Phase 2).
- Streaming or generator support (Phase 2).
- Binary or non-JSON payload optimisation (Phase 2).

If a requirement below seems to need one of these, stop and raise it rather than implementing it.

## Interface specification

### `python-env` (configuration node)

Type name: `python-env`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | no | Display label |
| `projectDir` | string | yes | Directory containing `pixi.toml` |
| `environment` | string | no | pixi environment name, default `default` |
| `startupTimeout` | number | no | Milliseconds to wait for worker readiness, default `120000` |

Behaviour:

- On deploy, verify `projectDir` exists and contains `pixi.toml`. If not, the node is in an error
  state and any `python-function` referencing it fails fast with a clear message.
- Install/resolve the environment (`pixi install`) before launching the worker. This can be slow on
  first run; the startup timeout must accommodate it.
- Launch exactly one worker process, lazily on first use or at deploy time (implementer's choice —
  document which).
- Shut the worker down cleanly on node close and on redeploy. No orphaned processes.

### `python-function` (execution node)

Type name: `python-function`. One input, one output.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | no | Display label |
| `env` | config node ref | yes | The `python-env` to run in |
| `target` | string | yes | `module:function`, e.g. `analytics.detect:run` |
| `codeDir` | string | no | Directory prepended to `sys.path`; defaults to the env's `projectDir` |
| `timeout` | number | no | Per-call timeout in ms, default `30000`; `0` disables |

Behaviour:

- On message: send `msg.payload` to the worker as the function's single argument. On success, set
  `msg.payload` to the return value and send on output 1. All other `msg` properties are preserved.
- On Python exception: call `node.error(err, msg)` so a `catch` node can handle it. The error object
  carries `type`, `message` and `traceback` from Python. Nothing is sent on the output.
- On timeout: same as an exception, with a distinguishable error type. The in-flight request is
  abandoned; consider whether the worker must be restarted and document the decision.
- Node status reflects reality: environment installing / worker starting / ready / running / error.

## Wire protocol

JSON Lines (one compact JSON object per line, UTF-8, `\n`-terminated) over the worker's stdin and
stdout. The worker's stderr is not part of the protocol and is forwarded to the Node-RED log.

This protocol is transport-agnostic on purpose: Phase 3 replaces stdio with a socket without
changing message shapes. Do not embed stdio-specific assumptions in the message format.

Request (Node-RED → worker):

```json
{"id": "a1b2c3", "op": "call", "target": "analytics.detect:run", "code_dir": "/opt/flows/py", "payload": {}}
```

Also required: `{"id": "...", "op": "ping"}` for health checks.

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

- `id` is generated by the Node-RED side and echoed verbatim. Responses may arrive in any order.
- The worker imports and caches the target callable on first use, keyed by `target` and `code_dir`.
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
│   ├── python-env.js           runtime: config node, environment + worker lifecycle
│   ├── python-env.html         editor: edit dialog and help
│   ├── python-function.js      runtime: execution node
│   └── python-function.html    editor: edit dialog and help
├── lib/
│   ├── worker.js               spawn, supervise, restart the worker process
│   └── protocol.js             framing, correlation IDs, pending-request table
├── python/
│   └── nrpyrun_worker/
│       ├── __init__.py
│       └── __main__.py         the worker loop
├── test/
│   ├── python-env_spec.js
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

1. `npm install` in a `~/.node-red` directory installs the package and both nodes appear in the
   palette under a `python` category.
2. A flow with `inject → python-function → debug`, configured against the test fixture project,
   returns the function's result.
3. The Python process is started once: calling the function 1000 times spawns exactly one process,
   verifiable in the logs.
4. Throughput of at least 200 messages/second for a trivial function on ordinary hardware.
5. Raising an exception in the Python function triggers a `catch` node, and the error carries type,
   message and traceback.
6. Killing the worker process externally causes an automatic restart, and the next message succeeds.
7. Redeploying the flow leaves no orphaned Python processes.
8. A `python-env` pointing at a non-existent directory produces a clear error at deploy time, not a
   stack trace at first message.
9. `npm test` passes; tests use `node-red-node-test-helper` and cover success, exception, timeout,
   worker restart and malformed-payload paths.
10. Both `.html` files contain editor help text explaining each field in user-facing terms (see the
    terminology rule).

## Working agreement

- Implement in this order: protocol and worker (`python/`, `lib/`) → config node → execution node →
  editor UI → tests. The Python worker can be developed and tested standalone first.
- Commit in logical units with meaningful messages. Do not squash the whole MVP into one commit.
- When a decision is left to the implementer above, record it in the PR description and, if it
  affects users, in the node's help text.
- If a requirement here conflicts with `ROADMAP.md` or `AGENTS.md`, stop and ask. Do not resolve the
  conflict unilaterally.
