---
name: node-red-testing
description: Test and locally install Node-RED nodes. Covers unit tests with node-red-node-test-helper (mocha and should), loading nodes with test flows, helper nodes, asserting on outputs, errors and status, and linking a node package into a local Node-RED user directory with npm install. Use when the user wants to test, debug, try out or verify a Node-RED node, or add a test folder to a node package.
license: Apache-2.0
compatibility: Requires Node.js (current LTS), npm, and network access to install dev dependencies.
metadata:
  source: https://nodered.org/docs/creating-nodes/first-node
---

# Testing Node-RED nodes

## Install dev dependencies

```sh
npm install --save-dev node-red node-red-node-test-helper mocha should
```

`node-red-node-test-helper` is a framework built on the Node-RED runtime for loading a node with a
test flow and asserting on its behaviour. Add to `package.json`:

```json
"scripts": { "test": "mocha \"test/**/*_spec.js\"" }
```

## Test file pattern: `test/<type>_spec.js` (verified with node-red 4.1 and node-red-node-test-helper 0.3.6)

```javascript
const helper = require("node-red-node-test-helper");
require("should");
const lowerNode = require("../lower-case/lower-case.js");

helper.init(require.resolve("node-red"));   // needed with recent test-helper versions

describe("lower-case Node", function () {
    beforeEach(function (done) { helper.startServer(done); });
    afterEach(function (done) { helper.unload().then(() => helper.stopServer(done)); });

    it("should be loaded", async function () {
        const flow = [{ id: "n1", type: "lower-case", name: "test name" }];
        await helper.load(lowerNode, flow);
        helper.getNode("n1").should.have.property("name", "test name");
    });

    it("should make payload lower case", async function () {
        const flow = [
            { id: "n1", type: "lower-case", name: "t", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        await helper.load(lowerNode, flow);
        const n1 = helper.getNode("n1"), n2 = helper.getNode("n2");
        await new Promise((resolve) => {
            n2.on("input", (msg) => { msg.should.have.property("payload", "uppercase"); resolve(); });
            n1.receive({ payload: "UpperCase" });
        });
    });
});
```

The official first-node page shows the older callback style (`helper.load(node, flow, cb)` with
`helper.unload()` in `afterEach`); depending on the helper version the callback style may still work. Always `helper.unload()` after each test.

## What to test

- Loads, and properties from the flow are applied to the node.
- Output for each input type: string, number, boolean, Buffer, object, array, null/undefined payload.
- Each output port of multi-output nodes (use one `helper` node per output in `wires`).
- Original `msg` properties preserved (e.g. `msg.topic` unchanged).
- Errors: `done(err)` makes the node emit `call:error`; assert on it (`n1.on("call:error", c => c.args[0])`
  gives the Error) or add a `catch` node to the flow and assert on the helper node behind it.
- Config nodes and credentials: include the config node in the flow and pass credentials as the third
  argument: `helper.load(node, flow, { n1: { secret: "s3" } })` (keys are node ids).
- `close`: `helper.unload()` must not hang (async cleanup must finish within the 15 s timeout).
- Status: `n1.on("call:status", c => c.args[0])` yields `{fill, shape, text}`. Attach the listener
  before triggering the behaviour you are testing.

Pitfalls:
- With mocha, never mix `done` and a returned promise. `beforeEach(done => helper.startServer(done))`
  fails with "Resolution method is overspecified" because the arrow returns the promise. Use block
  bodies: `beforeEach(function (done) { helper.startServer(done); });`
- Wrap assertions inside `input` callbacks in try/catch and pass the error to `done(e)`, otherwise a
  failed assertion times out instead of reporting.
- Call `helper.unload()` after every test so nodes from earlier tests do not leak.

The helper's README contains more examples taken from core node tests.

## Try it in a real Node-RED

Link the module into your Node-RED user directory (typically `~/.node-red`):

```sh
cd ~/.node-red
npm install /path/to/node-red-contrib-your-node
# add --no-save to avoid recording it in the user directory's package.json
```

This creates a symlink under `~/.node-red/node_modules`. Restart Node-RED to pick up changes to the
node files. Windows example: `npm install C:\Users\me\Documents\GitHub\node-red-contrib-your-node`.

Manual smoke test: drag the node into a flow with Inject and Debug nodes, edit and deploy, check the
Info tab help, the edit dialog validation (leave a required field empty), error handling (send a
bad payload and confirm a Catch node fires), redeploy (confirm `close` cleans up), and status.
