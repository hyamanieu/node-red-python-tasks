---
name: node-red-config-and-credentials
description: Add configuration nodes (shared connections or settings used by several nodes) and credentials (secret values like passwords and tokens that are stored outside the flow file) to a Node-RED node. Use when a node needs a server/broker/API connection shared across nodes, a username/password/API key, OAuth tokens, or when the user asks where to store secrets in a Node-RED node.
license: Apache-2.0
metadata:
  source: https://nodered.org/docs/creating-nodes/config-nodes ; https://nodered.org/docs/creating-nodes/credentials
---

# Configuration nodes and credentials

## When to use which

| Need | Use |
|---|---|
| Settings or a connection shared by several nodes (broker, server, account) | **Config node** |
| A secret (password, API key, token) | **credentials** (on the node, or on its config node) |
| Per-node non-secret option | `defaults` property (see `node-red-editor-ui`) |

Credentials are stored separately from the flow file and are **not included when flows are exported**.
Never put secrets in `defaults`.

## Config node

Same shape as a normal node with two differences: `category: 'config'`, and the edit template inputs
use ids `node-config-input-<property>`. Config nodes are global by default (state shared across flows).

`remote-server.html`

```html
<script type="text/javascript">
    (function () {
        'use strict';
        RED.nodes.registerType('remote-server', {
            category: 'config',
            defaults: {
                host: { value: "localhost", required: true },
                port: { value: 1234, required: true, validate: RED.validators.number() }
            },
            label: function () { return this.host + ":" + this.port; }
        });
    }());
</script>

<script type="text/html" data-template-name="remote-server">
    <div class="form-row">
        <label for="node-config-input-host"><i class="fa fa-bookmark"></i> Host</label>
        <input type="text" id="node-config-input-host">
    </div>
    <div class="form-row">
        <label for="node-config-input-port"><i class="fa fa-bookmark"></i> Port</label>
        <input type="text" id="node-config-input-port">
    </div>
</script>
```

`remote-server.js`

```javascript
module.exports = function (RED) {
    function RemoteServerNode(n) {
        RED.nodes.createNode(this, n);
        this.host = n.host;
        this.port = n.port;
        // If it owns a connection: create it here, expose it to users, and handle 'close'
        // to disconnect when the node is stopped.
    }
    RED.nodes.registerType('remote-server', RemoteServerNode);
};
```

Add a help block for config nodes too (`data-help-name="remote-server"`).

### Using a config node from another node

Editor definition: a property whose `type` is the config node type. The editor replaces the
`<input id="node-input-server">` with a select of existing instances plus an edit button.

```javascript
defaults: { server: { value: "", type: "remote-server", required: true } },
```

```html
<div class="form-row">
    <label for="node-input-server"><i class="fa fa-globe"></i> Server</label>
    <input type="text" id="node-input-server">
</div>
```

Runtime:

```javascript
module.exports = function (RED) {
    function MyNode(config) {
        RED.nodes.createNode(this, config);
        this.server = RED.nodes.getNode(config.server);
        if (this.server) {
            // use this.server.host, this.server.port
        } else {
            // not configured: set a status/warn, do not crash
        }
    }
    RED.nodes.registerType('my-node', MyNode);
};
```

Both node types must be listed in `package.json` `node-red.nodes` (the same file may contain both;
list a file only once).

Shared connection pattern: the config node creates and owns the connection and handles `close`;
using nodes register/unregister themselves and display connection state via `status`. Config nodes
cannot assume flow-scoped context.

## Credentials

Three places must agree.

1. **Editor definition** (`.html`):

```javascript
credentials: {
    username: { type: "text" },
    password: { type: "password" }
},
```

2. **Edit template**: same id convention as properties.

```html
<div class="form-row">
    <label for="node-input-username"><i class="fa fa-tag"></i> Username</label>
    <input type="text" id="node-input-username">
</div>
<div class="form-row">
    <label for="node-input-password"><i class="fa fa-tag"></i> Password</label>
    <input type="password" id="node-input-password">
</div>
```

(Config node: `node-config-input-username`, etc.)

3. **Runtime registration** (`.js`):

```javascript
RED.nodes.registerType("my-node", MyNode, {
    credentials: {
        username: { type: "text" },
        password: { type: "password" }
    }
});
```

Credential `type` is `text` or `password` only.

### Access

- Runtime: `this.credentials.username`, `this.credentials.password`.
- Editor: `text` credentials are in `this.credentials.<name>`; `password` credentials are **not
  available**, only a boolean `this.credentials.has_password` showing whether a value is set.
- Credentials cannot be used in the node's `label` function.
- Never log credential values or include them in `msg`, status text or error messages.

### Advanced (server-assigned secrets, e.g. OAuth)

When a node must keep values the user never types (OAuth tokens), the credentials system supports
extra stored values. The official example is the Twitter node:
https://github.com/node-red/node-red-nodes/tree/master/social/twitter

## Review checklist

- [ ] config node: `category: 'config'`, ids `node-config-input-*`, `close` handler if it holds a connection
- [ ] consumer: `type` set on the property; `RED.nodes.getNode` result null-checked
- [ ] credentials declared in both the HTML definition and `registerType` options
- [ ] no secrets in `defaults`, logs, status or messages
