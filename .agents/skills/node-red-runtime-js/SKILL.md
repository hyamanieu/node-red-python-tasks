---
name: node-red-runtime-js
description: Write or review the runtime JavaScript file of a Node-RED node, including the constructor, input handler with send/done, error handling, multiple outputs, close handler, logging, node status, context storage, and settings.js options. Use when implementing node behaviour, fixing message handling bugs, adding async work, connections or timers, or setting a node's status.
license: Apache-2.0
metadata:
  source: https://nodered.org/docs/creating-nodes/node-js
---

# Runtime JavaScript file

The `.js` file defines runtime behaviour. It exports a function that receives `RED` (the runtime API)
and registers one or more node types.

## Skeleton

```javascript
module.exports = function (RED) {
    function SampleNode(config) {
        RED.nodes.createNode(this, config);   // MUST be first
        const node = this;
        node.prefix = config.prefix;          // copy editor properties you need

        node.on('input', function (msg, send, done) {
            try {
                msg.payload = node.prefix + String(msg.payload);
                send(msg);
                done();
            } catch (err) {
                done(err);                    // triggers Catch nodes on the same tab
            }
        });

        node.on('close', function (removed, done) {
            // release timers, sockets, listeners
            done();
        });
    }
    RED.nodes.registerType('sample', SampleNode);
};
```

The registered type name must match the HTML file and `package.json`.

## Receiving messages

- Listen to `input`. Since Node-RED 1.0 the listener gets `(msg, send, done)`.
- **Always call `done()` exactly once** when finished handling a message (also after async work).
- Report failures with `done(err)`. In Node-RED 0.x there is no `done`; fall back to `node.error(err, msg)`.
- Targeting only Node-RED >= 1.0? Set `"node-red": {"version": ">=1.0.0"}` and skip the fallbacks.
  For maximum compatibility use:

```javascript
node.on('input', function (msg, send, done) {
    send = send || function () { node.send.apply(node, arguments); };
    // ...
    if (err) { done ? done(err) : node.error(err, msg); return; }
    if (done) { done(); }
});
```

## Sending messages

- Inside an `input` handler use the `send` argument. For nodes that emit on external events
  (timers, sockets), use `node.send(msg)`.
- **Reuse the received `msg`** instead of creating a new object so existing properties survive.
- `send(null)` (a null `msg`) sends nothing.
- **Multiple outputs**: pass an array, one entry per output: `send([msg1, msg2])`. Use `null` for an
  output that should not fire: `send([null, msg2])`.
- **Multiple messages to one output**: nest an array: `send([[msgA1, msgA2, msgA3], msg2])`.

## Handling errors

- Wrap synchronous logic in try/catch and register error handlers on every async call (callbacks,
  promise `.catch`, event emitter `'error'`). An uncaught exception stops the entire runtime.
- Pass errors to `done(err)` for per-message failures; use `node.error(err)` for failures not tied to
  a message (e.g. background connection errors).

## Closing the node

On every deploy existing nodes are deleted. Register a `close` listener to tidy up (clear intervals,
close sockets, remove listeners).

```javascript
node.on('close', function () { /* sync cleanup */ });
node.on('close', function (done) { asyncCleanup(done); });                 // async
node.on('close', function (removed, done) {                                // since 0.17
    // removed === true: deleted or disabled; false: restarting
    done();
});
```

If the listener takes a callback, the runtime waits for it, but **times out after 15 seconds**
(since 0.17), logs an error and continues. Always call it.

## Logging

```javascript
node.log("info");           node.warn("shown in debug tab too");
node.error("shown in debug tab too");
node.trace("internal detail");   node.debug("debug detail");   // since 0.17
```

`warn` and `error` also appear in the editor's debug sidebar.

## Status

```javascript
node.status({ fill: "green", shape: "dot", text: "connected" });
node.status({ fill: "red", shape: "ring", text: "disconnected" });
node.status({});   // clears the status
```

- `fill`: `red`, `green`, `yellow`, `blue`, `grey`. `shape`: `ring` or `dot`.
- Keep `text` short (under ~20 characters). Status can be caught by the Status node.
- For internationalised status text, pass a message id (see `node-red-packaging-publishing`
  `references/i18n-and-resources.md`).

## Context storage

Custom nodes must access context themselves (no predefined variables as in the Function node):

```javascript
const nodeCtx   = node.context();          // visible only to this node
const flowCtx   = node.context().flow;     // all nodes on the same tab
const globalCtx = node.context().global;   // all nodes
nodeCtx.set('count', (nodeCtx.get('count') || 0) + 1);
```

Same `get`/`set` API as the Function node. Config nodes are global by default, so a config node
cannot assume access to flow context.

## Custom settings (settings.js)

- Name must be prefixed with the node type, camelCase (`sample-node` + `colour` becomes
  `sampleNodeColour`), and must have a sensible default (users are never required to set it).
- Read in the runtime: `RED.settings.sampleNodeColour`.
- To expose it to the editor (since 0.17) declare it in `registerType`:

```javascript
RED.nodes.registerType("sample", SampleNode, {
    settings: { sampleNodeColour: { value: "red", exportable: true } }
});
```

A setting with a non-conforming name logs an error.

## Review checklist

- [ ] `RED.nodes.createNode(this, config)` first line of constructor
- [ ] Editor property values copied from `config` before use
- [ ] Every code path calls `done` once (success, error, early return)
- [ ] No uncaught async errors; no unhandled promise rejections
- [ ] `close` releases everything the constructor started
- [ ] Reuses `msg`; documents the properties it sets
- [ ] Accepts string / number / boolean / Buffer / object / array / null payloads sensibly
