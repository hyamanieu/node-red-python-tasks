# Contributing to node-red-python-tasks

Thank you for your interest in contributing to node-red-python-tasks! This document outlines the process for contributing to the project.

## Getting Started

1. **Read the documentation**:
   - [README.md](./README.md) - User-facing documentation
   - [ROADMAP.md](./ROADMAP.md) - Project roadmap and phased development plan
   - [AGENTS.md](./AGENTS.md) - Development conventions and setup

2. **Set up the development environment**:
   - Follow the instructions in [Phase 0 - Development Environment](./ROADMAP.md#phase-0---development-environment)
   - Use `docker compose up -d` to start the development environment
   - The development environment includes Node-RED with this package installed in development mode

3. **Check the current phase**:
   - This project follows a strict phased development approach
   - Only implement features that belong to the current phase (Phase 1 - MVP)
   - If you have an idea for a feature in a later phase, please file an issue rather than implementing it

## Development Workflow

### Setting Up

```bash
# Clone the repository
git clone https://github.com/hyamanieu/node-red-python-tasks.git
cd node-red-python-tasks

# Start the development environment
docker compose up -d

# View Node-RED logs
docker compose logs -f node-red

# Access Node-RED editor at http://localhost:1880
```

### Making Changes

1. **Follow the conventions** outlined in [AGENTS.md](./AGENTS.md)
2. **Use relative paths** for all file references within the project
3. **User-facing strings** should refer to "Python environments" not "pixi"

### Testing

```bash
# Run tests
docker compose exec node-red npm test

# Or run specific test files
docker compose exec node-red mocha test/lib/protocol_spec.js
```

### Code Organization

- `nodes/` - Node-RED node implementations (`.js` runtime + `.html` editor)
- `lib/` - Shared library code
- `python/` - Python worker code
- `test/` - Test suites
- `examples/` - Example flows

## Reporting Issues

When reporting issues, please include:

1. The version of Node-RED you're using
2. The version of Node.js
3. The configuration of your python-env node
4. The flow JSON that reproduces the issue
5. Any error messages from the Node-RED log
6. Steps to reproduce the issue

## Pull Request Guidelines

1. **Follow the phased approach**: Do not implement features from later phases
2. **Keep commits atomic**: Each commit should address a single logical change
3. **Write meaningful commit messages**: Explain what changed and why
4. **Include tests**: New functionality should be accompanied by tests
5. **Update documentation**: If your change affects users, update the help text in the `.html` files
6. **Match existing code style**: Follow the conventions in the surrounding code

### Pull Request Checklist

- [ ] All acceptance criteria from the current phase are met
- [ ] Tests pass (`npm test`)
- [ ] Code follows the conventions in AGENTS.md
- [ ] No orphaned processes can be left behind
- [ ] Errors are properly propagated to catch nodes
- [ ] Worker processes are properly cleaned up on node close/redeploy
- [ ] User-facing strings use "Python environment" terminology

## Code of Conduct

This project follows a simple code of conduct:

- Be respectful and inclusive
- Focus on the technical merit of contributions
- Follow the project's design principles and phased approach
- When in doubt, ask questions rather than making assumptions

## Architecture Decisions

This project makes several deliberate architectural choices:

1. **Pixi as an implementation detail**: Users interact with "Python environments", not directly with pixi
2. **Persistent worker processes**: python-function nodes share a worker process per environment for low latency
3. **JSON-lines protocol**: Transport-agnostic protocol that can be extended to sockets in Phase 3
4. **Single-threaded synchronous workers**: Simple, predictable behavior that processes one request at a time
5. **Containerized development**: Ensures reproducible development and testing environments

Please respect these architectural decisions when contributing.

## Questions?

If you have questions about:
- Whether a feature belongs in this project
- The project's roadmap or phased approach
- How to implement something within the constraints

Please open an issue to discuss before starting implementation.
