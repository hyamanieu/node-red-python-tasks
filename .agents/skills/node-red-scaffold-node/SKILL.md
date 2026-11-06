---
name: node-red-scaffold-node
description: Generate a new, working Node-RED node package (package.json with node-red section, runtime .js, editor .html with help, mocha test, example flow, README, LICENSE) using a bundled dependency-free script, and explain how the pieces fit. Use when starting a new Node-RED node, creating a node-red-contrib project, or when the user says "create a Node-RED node" and there is no package yet.
license: Apache-2.0
compatibility: Requires Node.js >= 18. Running the generated tests needs npm and network access.
metadata:
  source: https://nodered.org/docs/creating-nodes/first-node
---

# Scaffold a node package

## Run the generator

```sh
node .agents/skills/node-red-scaffold-node/scripts/scaffold.js \
  --name @myscope/node-red-contrib-hello \
  --type hello \
  --out ./node-red-contrib-hello \
  --description "Adds a prefix to payloads" \
  --author "Your Name"
```

Options: `--category` (palette category, default `function`), `--license` (default MIT; other ids
require adding the LICENSE text manually), `--node-red` (supported range, default `>=2.0.0`),
`--force` (write into a non-empty directory), `--help`.

Choose:
- `--name`: scoped npm name (see `node-red-packaging-publishing`).
- `--type`: the node type, lowercase with hyphens. It is the identifier used in the editor, flows and
  `package.json`. Make it unique and descriptive.

## What it creates

```
<out>/
├── package.json            # name, version, node-red.nodes + node-red.version, devDependencies, test script
├── <type>/
│   ├── <type>.js           # runtime: createNode, input(msg, send, done), close
│   └── <type>.html         # editor definition + edit template + help text
├── test/<type>_spec.js     # mocha + node-red-node-test-helper tests
├── examples/<Title>.json   # importable example flow with a comment node
├── README.md
├── LICENSE                 # MIT only
└── .gitignore
```

It deliberately leaves `keywords` empty: add `"node-red"` only when the node is stable and documented.

## After generating

1. `cd <out> && npm install && npm test` (the two generated tests should pass).
2. Replace the demo behaviour (prefixing the payload) with the real behaviour:
   - runtime: `node-red-runtime-js`
   - editor/help: `node-red-editor-ui`
   - shared connections or secrets: `node-red-config-and-credentials`
3. Update tests (`node-red-testing`), then validate and package (`node-red-packaging-publishing`).

## Manual creation (when the script cannot be used)

Create three files and keep the type string identical across them:

`package.json` (generate with `npm init`, then add):

```json
"node-red": { "nodes": { "lower-case": "lower-case.js" } }
```

`lower-case.js`

```javascript
module.exports = function (RED) {
    function LowerCaseNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.on('input', function (msg) {
            msg.payload = msg.payload.toLowerCase();
            node.send(msg);
        });
    }
    RED.nodes.registerType("lower-case", LowerCaseNode);
};
```

`lower-case.html`: registers the same type with `category`, `defaults: { name: {value: ""} }`, `inputs`,
`outputs`, `icon`, `label`, plus `data-template-name` and `data-help-name` blocks (see `node-red-editor-ui`).

This is the official tutorial example (package name `node-red-contrib-example-lower-case`). It is a
teaching example: **do not publish it to npm**. Prefer the generated version above, which uses the
modern `send`/`done` listener and reports errors properly.

## Install the node into Node-RED for a manual check

```sh
cd ~/.node-red
npm install /path/to/your/node-package
```

Restart Node-RED after changing node files.
