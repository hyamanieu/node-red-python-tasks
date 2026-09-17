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
