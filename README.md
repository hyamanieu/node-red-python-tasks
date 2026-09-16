# node-red-python-tasks

**Call Python from your Node-RED flows — on this machine, in a container, or on a cloud GPU —
without changing the flow.**

> **Status: pre-alpha.** Nothing is published to npm yet. This repository is public early so the
> design can be discussed in the open. See [ROADMAP.md](./ROADMAP.md) for the plan.

## The idea

Node-RED is very good at talking to the physical world: PLCs, serial buses, MQTT brokers, OPC-UA
servers, REST APIs. It is much less comfortable when the next step is *compute* — fitting a model,
resampling a few million rows, running an image through a vision pipeline. That work belongs in
Python.

Today the answer is an `exec` node running `python script.py`. This package replaces that with
something you can actually put in production:

```
[ MQTT in ] → [ python-function: detect_anomaly ] → [ switch ] → [ alert ]
```

You write a normal Python function. The node calls it. The return value comes out of the node.
Exceptions become Node-RED errors you can handle with a `catch` node.

## What you get over an `exec` node

**It is fast.** The Python process stays alive between messages, so you pay for interpreter
start-up and imports once, not on every message. `exec` costs hundreds of milliseconds to several
seconds per call; that is fine once an hour and unusable at 10 Hz.

**It works the same everywhere.** Your flow depends on a specific set of Python packages —
including the compiled ones with system-level dependencies that break when you move between a
laptop, a factory gateway and a server. This package pins all of that behind the scenes, so an
environment that works here works there.

**It can move to bigger hardware without a rewrite.** When a function outgrows the machine running
Node-RED, you change where the environment runs — not the flow:

| Where the code runs | Good for |
| --- | --- |
| The Node-RED host | The common case: fast, low-latency, no extra infrastructure |
| A container | Isolation, resource limits, heavy dependency trees |
| A cloud machine, on demand | Jobs needing a GPU or far more RAM than your gateway has |

Same node, same wiring, same Python function. Only the environment's configuration changes.

**The contract is data, not text.** Values are converted at the boundary. You are not serialising
to a command line and parsing stdout by hand.

## Two nodes

- **`python-env`** (configuration node) — describes a Python environment: which packages it needs,
  and where it runs. Owned once, referenced by many nodes.
- **`python-function`** — references a `python-env` and a Python callable. Messages in, results out.

## How it works under the hood

You do not need to read this section to use the package.

Environments are managed with [pixi](https://pixi.sh), which resolves dependencies against
conda-forge and writes a lockfile. That is the machinery behind "it works the same everywhere": a
lockfile pins compiled and system-level libraries that `pip` and `venv` cannot, and it is what makes
it possible to reproduce an environment inside a container image or on a remote machine from the
same definition you used locally.

If you already maintain a `pixi.toml`, point the config node at it and it will be used as-is. If you
do not, declare your dependencies in the node and one is generated for you. Either way, pixi is an
implementation detail you are free to ignore — but it is also the reason the same flow can run
unchanged on three very different machines.

Cloud execution is planned via [SkyPilot](https://skypilot.readthedocs.io/).

## Design principles

1. **The common case needs nothing extra.** Node-RED plus this package should be enough to run
   Python locally. No broker, no database, no orchestrator.
2. **The flow should not encode where code runs.** Moving a function to a container or a GPU node is
   a configuration change.
3. **Built for unattended operation.** These flows run for months with nobody logged in. Workers
   restart, failures are visible, and a broken environment fails loudly at deploy time rather than
   silently at 03:00.
4. **No JavaScript required.** You write Python. The Node-RED side is configuration.

## Non-goals

- Replacing Node-RED's `function` node for ordinary message munging.
- Being a workflow orchestrator. If you need retries, schedules, backfills and run history, use a
  real orchestrator — the container tier is designed to be able to delegate to one later.
- Shipping a Python distribution.

## Related work

Several existing packages run Python from Node-RED — `node-red-pythonshell`,
`node-red-python-venv`, `node-red-python-function` and others. The better ones
already keep a worker process alive. They rely on `venv`/`pip`, so environments are only as
reproducible as the host they land on, and none offer a path to running the same function on other
hardware. If those packages already meet your needs, use them — they are mature and this one is not,
yet.

## Installation

Not yet publishable. Once released:

```bash
cd ~/.node-red
npm install node-red-python-tasks
```

[pixi](https://pixi.sh/latest/#installation) must be available on the host (or inside the container
running Node-RED). It is a single static binary with no dependencies of its own.

## Examples

End-to-end examples — a full industrial stack with ingestion, storage and dashboards — live in a
separate repository so this one stays focused on the nodes: **`node-red-python-tasks-examples`**
(published once the first release works).

## Contributing

Issues and design discussion are welcome now. Code contributions will be easier to accept once the
interfaces have stopped moving. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Licence

[MIT](./LICENSE)
