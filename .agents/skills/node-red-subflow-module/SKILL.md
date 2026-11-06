---
name: node-red-subflow-module
description: Package a Node-RED subflow as an installable npm module that appears in the palette as a normal node (experimental, Node-RED 1.3+). Use when the user wants to publish or distribute a subflow, turn a subflow into a node package, or asks about RED.nodes.registerSubflow and subflow.json.
license: Apache-2.0
metadata:
  source: https://nodered.org/docs/creating-nodes/subflow-modules
---

# Packaging a subflow as a module

Subflow modules were added in **Node-RED 1.3** and are **experimental**: test thoroughly before
publishing. Installed modules show up as regular nodes; users cannot see or edit the inner flow.
The process is currently manual (hand-editing JSON).

## 1. Prepare the subflow in the editor

Checklist:
- **Configuration**: define subflow properties and their UI in the Subflow Properties edit dialog.
- **Error handling**: handle errors inside where sensible; pass others out so users can handle them.
- **Status**: optionally add a custom status output that the Status node can catch.
- **Appearance**: give it a meaningful icon, colour and category.

Set module metadata in the Subflow Module Properties dialog: `Module` (npm name), `Node Type`
(defaults to the subflow `id`; set a unique, meaningful value), `Version`, `Description`, `License`,
`Author`, `Keywords`.

## 2. Create the module directory

```sh
mkdir node-red-example-subflow && cd node-red-example-subflow
npm init          # answer using the subflow metadata
```

Add a `README.md`, then a JavaScript wrapper (`example.js`):

```javascript
const fs = require("fs");
const path = require("path");

module.exports = function (RED) {
    const subflowFile = path.join(__dirname, "subflow.json");
    const subflowContents = fs.readFileSync(subflowFile);
    const subflowJSON = JSON.parse(subflowContents);
    RED.nodes.registerSubflow(subflowJSON);
};
```

## 3. Produce `subflow.json`

1. Add an instance of the subflow to a workspace; select it; export (`Ctrl-E`), preferring the
   formatted JSON option.
2. The export is an array: inner nodes..., then the **Subflow Definition**, then the **Subflow Instance**
   (last).
3. Delete the Subflow Instance (last entry).
4. Make the Subflow Definition the top-level object (move it above the array's `[`).
5. Move the remaining inner nodes into the definition as a `"flow": [ ... ]` property; fix trailing commas.
6. Save as `subflow.json`.

```json
{
    "id": "Subflow Definition Node",
    "flow": [ { "id": "Node 1" }, { "id": "Node n" } ]
}
```

(abbreviated; keep all real properties)

## 4. package.json

```json
{
    "name": "node-red-example-subflow",
    "node-red": { "nodes": { "example-node": "example.js" } }
}
```

If the subflow uses non-core nodes, list them twice: in top-level `dependencies` **and** in
`node-red.dependencies`:

```json
"node-red": {
    "nodes": { "example-node": "example.js" },
    "dependencies": [ "node-red-node-random" ]
},
"dependencies": { "node-red-node-random": "1.2.3" }
```

## 5. Finish

Follow `node-red-packaging-publishing` for naming (scoped name), README, LICENSE, examples,
`node-red.version` (use `>=1.3.0`), and publishing. Test by installing the folder into
`~/.node-red` (`npm install <path>`) and confirm the node appears in the palette and works.
