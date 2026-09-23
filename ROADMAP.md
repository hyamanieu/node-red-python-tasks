# Roadmap

Where `node-red-python-tasks` is going, and — just as importantly — what it is deliberately
not doing yet. Written for humans evaluating the project and for coding agents that need context
beyond the task in front of them.

**Read this before proposing or implementing changes.** A change that is technically sound but
belongs to a later phase should be filed as an issue, not implemented early.

## Guiding constraint

This is a small project maintained by one person. Scope is the main risk to it, not difficulty.
Each phase must produce something independently useful and shippable. A phase is not started until
the previous one is released, documented, and has survived contact with real flows.

## Development approach

For development and testing, **everything runs in containers** — including Node-RED itself. This ensures
a reproducible development environment and isolates dependencies. In production, the package runs
wherever Node-RED is deployed (which may itself be a container, but that is transparent to the node).

## Positioning, and what it implies

The value proposition is *"Python in your flows, anywhere, without a rewrite"*. Reproducible
environments are how that is achieved, not what is being sold. Concretely:

- User-facing names, documentation and error messages talk about **Python environments**, not about
  pixi. `pixi` belongs in package keywords, in the "how it works" section, and in code.
- A user who has never heard of pixi must be able to get to a working flow. If a phase's design
  requires the user to understand the environment manager, that design is wrong.
- Conversely, a user who already maintains a `pixi.toml` must be able to point at it and have it
  used as-is. Power users are not forced through a simplified abstraction.

## Phase 0 — Development environment ✅

**Goal:** a reproducible containerised development environment so work on Phase 1 can begin.

- Docker Compose configuration running Node-RED with this package installed in development mode
- pixi available inside the container for environment resolution
- Hot-reload or symlink setup so code changes are picked up without container rebuild
- Verification that the basic Node-RED + package install works in this setup

**Definition of done:** a developer can clone the repository, run one command, and have a working
Node-RED instance with both nodes available in the palette, ready for Phase 1 implementation.

## Phase 1 — Local execution (MVP)

**Goal:** replace the `exec`-node pattern with something reproducible and fast, on a single host.

In **production**, Python runs directly on the host where Node-RED is running. In **development and
testing**, everything (including Node-RED) runs in containers as established in Phase 0.

- `python-workspace` configuration node: define an environment by listing dependencies with version specs
  (e.g., `["python=3.9", "numpy=1"]`), internally create and manage a pixi project, resolve and install
  it, report status in the editor. Users do not need filesystem access to the host.
- `python-function` node: references an environment and stores a Python function body as text; executed
  via a persistent worker process per environment using a JSON-lines protocol for low latency. The
  worker is a synchronous, single-threaded loop — one request from a given environment is fully
  processed before the next begins.
- `python-run` node: references an environment and stores a command name (and optionally fixed arguments);
  executed as one process per invocation via `pixi run -e <environment> -x <command> [args...]`.
  Payload passed via stdin or argv, result captured from stdout. Non-zero exit status mapped to a
  catchable Node-RED error.
- Persistent worker process per environment for `python-function`, so start-up and imports are paid once.
- Structured request/response protocol with correlation IDs for `python-function`.
- Python exceptions (`python-function`) and non-zero exit codes (`python-run`) become Node-RED errors
  catchable with a `catch` node.
- Worker supervision: restart on crash, backoff, clear node status.
- Test suite with `node-red-node-test-helper`, and CI.

**Definition of done:** a user can install the package, declare dependencies in the node UI, call a
function from a flow at a few hundred messages per second, and leave it running for a week.

Implementation instructions: [docs/agent/MVP.md](./docs/agent/MVP.md).

## Phase 2 — Ergonomics

Driven by whatever Phase 1 users complain about first. Candidates, in rough priority order:

- **Direct TOML editing**: Text field in node UI for writing complete pixi.toml content, for users
  who prefer direct control over their environment definition.
- Optional input/output schemas, validated at the boundary and surfaced in the editor.
- Multiple worker processes per environment for CPU-bound parallelism (resolves the MVP's
  concurrency limitation where one worker processes requests strictly sequentially).
- Streaming and generator support: one input message producing many output messages.
- Efficient handling of non-JSON payloads (arrays, dataframes, bytes) without a JSON round-trip.

## Phase 3 — Container execution

**Goal:** create **separate containers** to execute Python code, with one image per Python environment.
One image = one Python environment. In development and testing, this means several containers would be
running simultaneously — for example, the container holding Node-RED (as in Phase 0/1) plus separate
containers executing individual Python functions or tests.

- Build a container image from an environment definition; the lockfile makes this reproducible and cacheable.
- Run each Python worker in its own isolated container, talking over a socket or HTTP instead of stdio.
- Resource limits, restart policies, health checks per container.
- Attach to an already-running container, for users who deploy images themselves.
- In dev/test mode: multiple containers coexist (Node-RED container + Python execution containers).

The Phase 1 wire protocol is deliberately transport-agnostic so this phase is a new transport, not a
new protocol.

## Phase 4 — Orchestrator-backed execution (optional)

For users who already run an orchestrator and want retries, concurrency limits, run history and an
observability UI without this project reimplementing any of it: allow the container tier to dispatch
to an existing orchestrator deployment instead of to a directly managed container.

Explicitly **optional**. Requiring an orchestrator for the common case would violate design
principle 1 and would not be welcome in the Node-RED ecosystem.

## Phase 5 — Cloud execution

**Goal:** a job too heavy for the gateway runs elsewhere, without the flow author learning cloud
infrastructure.

- Dispatch a function to a cloud instance via SkyPilot, on-demand and spot.
- Ship the environment and inputs, retrieve outputs, tear down.
- Guardrails: cost ceilings, timeouts, explicit opt-in.

This is where the project stops being incrementally better than the `exec` node and becomes
something with no real equivalent. It also has the most unknowns, which is why it is last.

## Possible side artifacts

Not part of this package, but natural by-products worth publishing separately:

- A SkyPilot-backed worker type for a Python orchestrator (useful outside Node-RED entirely).
- A reference industrial stack — ingestion, storage, dashboards — as the flagship example.

## Out of scope, indefinitely

- Managing Node-RED instances themselves (fleet management, multi-tenancy). Other projects do this.
- Bundling or installing the environment manager.
- Windows-specific process management beyond what works out of the box. Linux is the primary target;
  other platforms are best-effort.
- Any feature that makes local execution require infrastructure beyond Node-RED and pixi.
