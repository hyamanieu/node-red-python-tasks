# Task brief: Phase 0 — Development environment

**Audience:** coding agent. Humans should read [README.md](../../README.md) and
[ROADMAP.md](../../ROADMAP.md) instead; this file is an implementation contract, not documentation.

**Prerequisite reading:** [AGENTS.md](../../AGENTS.md), then `ROADMAP.md` (for the Phase 0
intermediate goal).

## Objective

Create a reproducible, containerised development environment so that Phase 1 implementation
can proceed without requiring local Node-RED or pixi installation on the developer's host.

Success is: a developer can clone the repository, run one command, and have a working Node-RED
instance with the package's nodes available in the palette, ready for implementation work.

## Scope

### In scope

1. **Docker Compose configuration** that launches:
   - A Node-RED container with this package installed in development mode (symlinked from the
     host repository into the container's node_modules)
   - pixi available inside the container for environment resolution
   - Any required volumes for hot-reload or persistent data
2. **Development mode installation** of `node-red-python-tasks` in the Node-RED container,
   so code changes on the host are picked up without container rebuild
3. **Verification** that Node-RED starts correctly and both node types are registered in the palette
4. **Documentation** of the setup command in a developer-facing README section

### Explicitly out of scope

- Production deployment configurations
- Building or publishing the npm package (this is Phase 1 territory)
- Any part of the actual node implementation (python-workspace, python-function, python-run)
- pixi project setup for the Python worker (can be minimal/empty for Phase 0)

## Requirements

### Docker setup

- A `compose.yml` at the repository root
- Uses official Node-RED Docker image with a fixed version yet latest node 22 (nodered/node-red:4.1.15-22). No `latest` even if provided in the example below.
- Fix pixi home, and version, an don't add to path: `wget -qO- https://pixi.sh/install.sh | PIXI_HOME=/usr/src/node-red/.pixi PIXI_VERSION=/v0.81.0 PIXI_NO_PATH_UPDATE=1 sh`
- Pixi should be added as a preinstall script in package.json so that the default "phase 1" setup works out of the box both in production and in dev environement
- Maps the repository directory into the container at the appropriate location for development
- Exposes Node-RED port (default 1880) to the host
- Includes pre-installed pixi and this npm package into the image

### Development installation

- The package is pre-installed in the Node-RED image via `npm install` within a Dockerfile
- Howver, Node-RED container must pick up changes to `.js` and `.html` files without container rebuild

### Node-RED configuration

- Node-RED should start with auto-install of nodes enabled (default behaviour is fine)
- The container should log Node-RED startup and node registration
- The Node-RED editor should be accessible at `http://localhost:1880`

### Verification

- Both `python-workspace` and `python-function` node types must appear in the Node-RED palette
  under a `python` category (even if their implementation is stubbed)
- A basic flow using an inject node and a debug node should work (to verify Node-RED itself)

## Repository additions

Create these files. Files marked `(exists)` are already present.

```
.
├── AGENTS.md                  (exists)
├── README.md                  (exists)  ← add Developer setup section
├── ROADMAP.md                 (exists)
├── compose.yml                new: Docker Compose configuration
├── Dockerfile                 new: used by compose.yml with package preinstalled
└── docs/
    └── agent/
        ├── Phase0.md          (this file)
        └── MVP.md             (exists)
├── package.json                the "node-red" key maps node types to their .js files
└── nodes/
    ├── python-workspace.js           working empty shell for now (developped in Phase 1)
    ├── python-workspace.html         working empty shell for now (developped in Phase 1)
    ├── python-function.js      working empty shell for now (developped in Phase 1)
    ├── python-function.html    working empty shell for now (developped in Phase 1)
    ├── python-run.js           working empty shell for now (developped in Phase 1)
    └── python-run.html         working empty shell for now (developped in Phase 1)
```

## Docker Compose specification

The Docker Compose file (named `compose.yml` per modern conventions) should provide:

```yaml
services:
  node-red:
    build: .
    container_name: node-red-dev
    ports:
      - "1880:1880"
    volumes:
      # Mount the repository into Node-RED's user directory
      - ./:/data/node-red-node-red-python-tasks
      # Persist Node-RED flows and node_modules for faster restarts
      - node-red-data:/data
    environment:
      - NODE_RED_ENABLE_SAFE_MODE=false

volumes:
  node-red-data:
```

The Dockerfile fixes nodered/node-red:4.1.15-22 and preinstalls the package. 

The implementer should choose and document the approach that best achieves:
1. Host code changes visible in container without rebuild
2. pixi available for Phase 1 work
3. Minimal startup time

## Basic test for setup


Testing of package installation should be done by running directly "docker run" of the standard `nodered/node-red:<testedversion>`  image, then executing the pixi install script for the tested pixi version, and finally ̀`npm install --ignore-scripts [...]` from within the temporary container.

This way, the latest functional pixi/nodered versions can be fixed into the compose.yml file.

## README addition

Add a "Developer setup" section to `README.md` with:

```markdown
## Developer setup

This project uses Docker Compose for development. No local Node-RED or pixi installation is required.

1. Clone this repository
2. Run `docker compose up -d`
3. Open http://localhost:1880 in your browser

The package is installed in development mode. Changes to files in `nodes/`, `lib/`,
`python/` will be picked up on Node-RED restart (currently requires manual restart
via the menu or `docker compose restart node-red`).

To stop: `docker compose down`.
```

## Acceptance criteria

The task is complete when all of the following hold:

1. `docker compose up -d` (or documented command) starts Node-RED accessible at
   `http://localhost:1880`
2. `python-workspace`, `python-function`, `python-run` node types appear in the Node-RED palette under
   a `python` category (and they do nothing for now)
3. Editing a file in `nodes/` on the host and restarting Node-RED (via the container) makes
   the changes take effect
4. pixi is available inside the container (verifiable via `docker compose exec node-red pixi --version`)
5. The repository's Docker setup is documented in the README
6. Running `docker compose down` and then `docker compose up -d` produces a clean, working state

## Working agreement

- Prefer the simplest Docker Compose configuration that meets the criteria
- Document any non-obvious choices in the PR description
- If pixi installation is slow, consider a multi-stage build or pre-built image
- The Phase 0 setup must work on Linux (Debian/Ubuntu)
- Do not add Node-RED persistence (flows) to version control — use a Docker volume
