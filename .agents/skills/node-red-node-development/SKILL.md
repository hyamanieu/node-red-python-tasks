---
name: node-red-node-development
description: Entry point for creating, extending or reviewing Node-RED nodes (custom nodes, node-red-contrib packages, palette nodes). Use whenever the user mentions Node-RED nodes, a node's .js/.html files, the palette, node-red-contrib, or wants to wrap an API/device/library as a Node-RED node, even if they do not say "skill". Provides design principles, the end-to-end workflow, a definition-of-done checklist, and routes to the more specific node-red-* skills.
license: Apache-2.0
metadata:
  source: https://nodered.org/docs/creating-nodes/
---

# Node-RED node development: workflow

A Node-RED node is an npm module made of:

- a **JavaScript file** (runtime behaviour, runs in Node.js),
- an **HTML file** (editor registration, edit dialog template, help text; runs in the browser),
- a **package.json** with a `node-red` section that tells the runtime which `.js` files to load.

Nodes are created when a flow is deployed, receive/send messages while it runs, and are deleted at the
next deploy. Never keep state that must survive a deploy on the node instance itself; use context.

## Design principles (from the official guide)

Apply these before writing code. A node should:

1. **Have a well-defined purpose.** Prefer several single-purpose nodes over one node exposing every
   option of an API.
2. **Be simple to use**, hiding complexity and jargon.
3. **Be forgiving about input.** `msg` properties may be strings, numbers, booleans, Buffers,
   objects, arrays or null. Handle each sensibly.
4. **Be consistent in what it sends.** Document every property it sets on messages.
5. **Sit at the start, middle or end of a flow, not all at once.** Input-only, output-only and
   pass-through are different node shapes.
6. **Catch errors.** An uncaught exception stops the whole runtime. Catch errors and register error
   handlers for every asynchronous call, and report them through `done(err)`.

## Workflow

Follow these steps in order and load the named skill at each step.

| Step | Do | Skill |
|---|---|---|
| 1 | Clarify: node purpose, shape (in / out / both), properties, external deps, secrets, target Node-RED version, package name | this file |
| 2 | Generate the package skeleton | `node-red-scaffold-node` |
| 3 | Implement runtime behaviour | `node-red-runtime-js` |
| 4 | Implement editor definition, edit dialog, help | `node-red-editor-ui` |
| 5 | If it shares a connection/settings or needs secrets | `node-red-config-and-credentials` |
| 6 | Write unit tests, install locally in Node-RED, try it | `node-red-testing` |
| 7 | README, LICENSE, examples, i18n, version range, validate, publish | `node-red-packaging-publishing` |
| alt | Distribute a subflow rather than coding a node | `node-red-subflow-module` |

Ask the user (a few concise questions at most) only for what cannot be inferred: package
name/scope, node type name, what the node does, and whether credentials or a shared connection are
needed. State assumptions explicitly and proceed.

## Cross-cutting rules

- The node **type** string must be identical in: `RED.nodes.registerType` (.js),
  `RED.nodes.registerType` (.html), `data-template-name`, `data-help-name`, and the key in
  `package.json` `node-red.nodes`.
- Reuse the incoming `msg` object when replying so other properties are preserved.
- Property names in `defaults` must not be any single character, nor `id`, `type`, `wires`,
  `inputs`, `outputs` (`outputs` only if deliberately making the output count configurable).
- Secrets belong in `credentials`, never in `defaults` (defaults are exported with flows).
- Wrap HTML-side JavaScript in an IIFE with `'use strict'` to avoid leaking globals.
- Custom settings read from `settings.js` must be prefixed with the node type, camelCase, and have
  a default (type `sample-node`, setting `colour` becomes `sampleNodeColour`).
- Do not publish tutorial/example nodes (such as `lower-case`) to npm.
- Do not add the `node-red` keyword to package.json until the node is stable and documented.

## Definition of done

- [ ] Node type name consistent everywhere (see above).
- [ ] Runtime: `RED.nodes.createNode` first; `input` handler uses `send`/`done`; errors go to
      `done(err)`; `close` handler releases timers, sockets, listeners.
- [ ] Editor: `category`, `defaults`, `inputs`, `outputs`, `icon`, `label` set; required fields
      flagged `required`/`validate`; `name` property present.
- [ ] Help text follows the help style guide (first `<p>` is the tooltip; Inputs / Outputs / Details).
- [ ] Credentials use the `credentials` mechanism; secret values never logged.
- [ ] Status shown for long-lived connections.
- [ ] Tests pass with `node-red-node-test-helper`; node loads and behaves in a real Node-RED instance.
- [ ] `package.json`: name (scoped for new packages), version, description, `node-red.nodes`,
      `node-red.version` range, dependencies, license.
- [ ] README.md and LICENSE present; `examples/` flows at the package root if provided.
- [ ] `validate-package.js` reports no errors.

## References

- `references/docs-index.md`: map of every official page used to build these skills.
