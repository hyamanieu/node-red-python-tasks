# AGENTS.md

## Setup commands

**Note:** For development and testing (Phase 1 and beyond), everything runs in containers. See Phase 0
in [ROADMAP.md](./ROADMAP.md) for the containerised development environment setup.

For development, use the following commands:

```bash
# Start the development environment
docker compose up -d

# View logs
docker compose logs -f node-red

# Execute commands in the running container
docker compose exec node-red bash

# Verify pixi is available
docker compose exec node-red pixi --version

# Stop the development environment
docker compose down
```

The `compose.yml` file uses a custom Docker image (built from `Dockerfile`) that includes:
- Node-RED 4.1.15 with Node.js 22
- pixi v0.81.0 installed at `/usr/src/node-red/.pixi`
- The `node-red-python-tasks` package installed in development mode
- The repository mounted as a volume at `/data/node-red-node-red-python-tasks` for live code changes

Changes to files in `nodes/`, `lib/`, or `python/` will be visible in the container immediately.
To pick up changes, restart Node-RED via the editor menu or run:

```bash
docker compose restart node-red
```

## Running tests and code (no local Node.js)

The host has no `node` on PATH — run everything inside the dev container:

```bash
# full suite, exactly as CI runs it
docker compose exec node-red bash -c 'cd /data/node-red-node-red-python-tasks && npm test'

# a single spec
docker compose exec node-red bash -c 'cd /data/node-red-node-red-python-tasks && npx mocha test/lib/project-manager_spec.js'

# long runs: redirect to a file inside the container, then read it
# (piping through `docker compose exec` can stall until the tool timeout)
docker compose exec node-red bash -c 'cd /data/node-red-node-red-python-tasks && timeout 100 npx mocha test/**/*_spec.js > /tmp/t.txt 2>&1; grep -E "passing|failing" /tmp/t.txt'

# docker logs runs on the HOST, not inside the container (no docker socket there)
docker logs node-red-dev
```

Container facts (from `Dockerfile`, `entrypoint.sh`, `compose.yml`):

- The repo is mounted at `/data/node-red-node-red-python-tasks` and symlinked to
  `/data/node_modules/node-red-python-tasks`; host edits are live in the container.
- `HOME=/data`; Node-RED's userDir is `/data`; the flows file is `/data/flows.json`
  (the base image sets `ENV FLOWS=flows.json` and `entrypoint.sh` passes it as the CLI arg,
  so `settings.flowFile === "flows.json"`).
- pixi is at `/usr/src/node-red/.pixi/bin/pixi` (`PIXI_HOME`), already on PATH; version v0.81.0.
- Node-RED's own source is readable at `/usr/src/node-red/node_modules/@node-red/...` — grep it
  to answer runtime questions instead of guessing (see the facts below, already verified there).
- Managed workspaces live in `/data/.node-red-python/workspaces`
  (`~/.node-red-python/workspaces`; override with `NODE_RED_PYTHON_ENV_DIR`).

## Code style

- Node.js 18+, target Node.js >= 22.13, CommonJS (`require` / `module.exports`) — no ESM, matching Node-RED's
  own runtime convention.
- Every node ships as a matched pair with the same base name:
  `nodes/<type>.js` (runtime) + `nodes/<type>.html` (editor UI, help text, edit
  dialog). Node-RED's loader depends on this pairing.
- Register each node `.js` file once under the `node-red.nodes` key in
  `package.json`; if a single file defines multiple node types, list it once.
- Any npm package a node needs at runtime goes in `package.json`'s `dependencies`
  — never assume something is globally installed.
- Do not add the `node-red` keyword to `package.json` until a node is stable,
  documented, and works end to end — this is Node-RED's own packaging guidance,
  not a project-specific rule.
- Package name: scoped, per Node-RED's post-2022 naming rules
  (e.g. `@scope/node-red-python-run`), not the older unscoped
  `node-red-*` pattern.
- Importable example flows live in an `examples/` directory at the package
  **root** (Node-RED requires this location), one JSON file per flow.
- Match surrounding code style; do not reformat files you are not otherwise
  changing.

## Node-RED runtime facts (verified against the container's Node-RED 4.1.15)

Sources: `@node-red/registry/lib/util.js`, `@node-red/runtime/lib/index.js`,
`@node-red/runtime/lib/flows/util.js`, `@node-red/runtime/lib/storage/localfilesystem/projects/index.js`.

- **Startup order:** `runtime.start()` → storage/settings init → `redNodes.load()` (each node
  module's exported function is called with `RED`) → … → `startFlows()`, which reads the flows
  from disk. Work done at the top level of a node module (e.g. reconciling the flows file on
  disk) therefore happens *before* Node-RED loads the flows and is picked up on that start.
- **The `RED` object given to node modules** exposes only: `nodes.createNode/getNode/eachNode/
  registerType/registerSubflow` plus the credentials helpers, `settings` (plain property access
  works, e.g. `RED.settings.userDir`, `RED.settings.flowFile`), `events`, `hooks` (message-routing
  and module-install hooks only — there is no flow-mutation hook), `httpAdmin`, `httpNode`,
  `server`, `log`, `_`. **There is no public API to add a config node to the already-loaded
  flows;** the only reliable injection point is the flows file on disk at module-load time.
- **Config nodes in the flow array:** an entry without `x`/`y` (and no tab `z`) is parsed as a
  global config node (`flow.configs` in `flows/util.js parseConfig`) — instantiated at deploy and
  shown in the editor's configuration sidebar. Inject config nodes as plain
  `{id, type, name, ...}` with no `z`/`x`/`y`/`wires`.
- **Flows file resolution:** `settings.flowFile` if set — absolute path as-is; `./name` relative
  to cwd; otherwise cwd if the file exists there; otherwise `<userDir>/<flowFile>`. If unset,
  Node-RED uses `<userDir>/flows_<hostname>.json`. Node-RED rewrites the flows file on every
  deploy and keeps a `.flows.json.backup`.
- **Editor visibility:** the editor reads the in-memory flow config via `GET /flows`; changes
  made to the flows file on disk appear after a process restart.
- **Config nodes are constructed before flow nodes**, and a `python-workspace` node stays in
  `initializing` until its async pixi setup resolves — execution nodes (`python-function`,
  `python-run`) must wait for the workspace's worker instead of erroring immediately.

## pixi CLI gotchas (verified with pixi v0.81.0 in the container)

`pixi run --help` shows pixi owns the flags *before* the command: `-e/--environment`,
`-m/--manifest-path`, `-x/--executable`. Therefore:

- Never write `pixi run -e default -m python -m nrpyrun_worker`: the first `-m` is consumed by
  pixi as `--manifest-path` and fails with `unable to canonicalize 'python'`. The worker is
  spawned as `pixi run -e <env> python -m nrpyrun_worker` (python's own `-m` comes after the
  executable). `lib/worker.js buildWorkerArgs()` builds this argv and is pinned by a test.
- `python-run` uses `pixi run -e <env> -x <command> [args...]` so the command is executed
  directly, not resolved as a pixi task.
- To check a workspace manually:
  `docker compose exec node-red bash -c 'cd /data/.node-red-python/workspaces/<name> && PYTHONPATH=/data/node-red-node-red-python-tasks/python pixi run -e default python -m nrpyrun_worker'`
  should print `{"op": "ready", "protocol": 1, "python": "..."}`.

## What this project is

A Node-RED package that lets users call Python functions from their flows, with environments managed
reproducibly so the same flow runs on a laptop, a gateway, a container or a cloud machine.

Read [README.md](./README.md) for the user-facing framing and [ROADMAP.md](./ROADMAP.md) for the
phased plan. **The roadmap is binding**: do not implement features belonging to a later phase, even
if they are easy. File an issue instead.

## Where task briefs live

Detailed, task-scoped implementation contracts are in `docs/agent/`. They are written for agents, not
for users, and are not linked from the user documentation except where a human might want to see the
plan.

Current brief: [docs/agent/MVP.md](./docs/agent/MVP.md).

When a brief and this file disagree, this file wins on conventions; the brief wins on scope.

## Positioning rule

The user-facing value proposition is "Python in your flows, anywhere, without a rewrite". The
environment manager (pixi) is an implementation detail.

- User-facing strings — node labels, editor help, status text, error messages, README prose — say
  "Python environment". They do not say "pixi", except where a field's value is literally a path to
  a `pixi.toml`.
- Code, comments, internal identifiers and `docs/agent/` may name pixi freely.
- A user who has never heard of pixi must still be able to reach a working flow.

## Conventions

- **Language/runtime:** Node.js 18+, CommonJS. Python 3.11+ for the worker.
- **Layout:** node runtime files in `nodes/` as `<type>.js` + `<type>.html` pairs (Node-RED requires
  matching base names); shared runtime logic in `lib/`; the Python worker in `python/`.
- **Dependencies:** no new runtime npm dependency without justification in the PR description. The
  package must stay light enough to install on a gateway.
- **Tests:** `node-red-node-test-helper` with mocha, in `test/`. New behaviour needs a test.
- **Commits:** logical units, meaningful messages. Do not squash an entire task into one commit.
- **Style:** match the surrounding code. No reformatting of files you are not otherwise changing.

## Package internals map

- `lib/project-manager.js` owns everything about on-disk workspaces: pixi root dir
  (`NODE_RED_PYTHON_ENV_DIR` or `~/.node-red-python/workspaces`), the pixi CLI wrapper
  (`runPixi`), workspace folder naming (`getWorkspaceName(name, deps)` — sanitized user-given
  name, dependency-hash fallback), creation/update (`createProject`), per-workspace metadata
  (`.node-red-workspace.json` via `saveWorkspaceMeta`/`readWorkspaceMeta`), discovery
  (`listWorkspaces`), manifest dependency recovery (`parseDependenciesFromManifest`), and
  flow-file reconciliation (`reconcileFlows`, `reconcileFlowsFile`, `getFlowsFilePath`).
  The workspaces on disk are the source of truth for which environments exist.
- `nodes/python-workspace.js` is the config node: at module load it calls
  `ProjectManager.reconcileFlowsFile(RED.settings)` (guarded, never throws); on deploy it calls
  `createProject(this.name, deps)` then `saveWorkspaceMeta(...)`, then starts one `WorkerManager`.
- `lib/worker.js` spawns and supervises the pixi worker process; `lib/protocol.js` is the
  JSON-lines framing. `nodes/python-function.js` and `nodes/python-run.js` are the execution
  nodes and only talk to the workspace's `WorkerManager`.
- Tests: `test/lib/*_spec.js` (set `NODE_RED_PYTHON_ENV_DIR` to a fresh tmp dir per test),
  `test/nodes/*_spec.js`.

## Test-writing notes

- `npm test` runs `mocha test/**/*_spec.js`; the shell glob expands to `test/*/*_spec.js`, so
  specs must live exactly one directory under `test/`.
- Node specs: capture the real constructor by having the mock `registerType` store it, then
  `new ctor(config)`; the mock `createNode` must add `on`, `status`, `error`, `warn`, etc.
  Node init is async — poll for a terminal `workerStatus` rather than a fixed number of ticks.
- In node specs, stub `ProjectManager.createProject` and `WorkerManager.prototype.start`:
  a real `start()` spawns pixi and its restart-backoff timers keep the mocha process alive
  (the suite hangs after printing its results).
- pixi-dependent tests self-skip when pixi is unavailable; in the dev container pixi IS
  available, so the `pixi CLI integration` tests run for real.
- Known pre-existing failure unrelated to workspace code: `test/lib/worker_spec.js`
  "should process ready messages". Do not chase it.
- Do not deploy flows through the running container's admin API (`POST /flows`) from an agent:
  it mutates shared runtime state and gets blocked by approval. Verify behaviour via unit tests,
  or by calling `ProjectManager` directly inside the container with a temp
  `NODE_RED_PYTHON_ENV_DIR`.

## Non-negotiables

- Never leave orphaned child processes. Every spawned process is cleaned up on node close and
  redeploy.
- Never let malformed input crash the worker. Bad input produces an error response.
- Errors reach the user through `node.error(err, msg)` so they are catchable, not only logged.
- This package is aimed at systems running unattended for months. Prefer boring, supervised,
  observable behaviour over clever behaviour.

## When to stop and ask

- A requirement appears to need a feature from a later roadmap phase.
- A brief conflicts with this file or with the roadmap.
- An acceptance criterion cannot be met without a design change.

Do not resolve these unilaterally.
