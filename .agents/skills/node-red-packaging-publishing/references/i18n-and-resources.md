# Internationalisation and editor resources

Sources: https://nodered.org/docs/creating-nodes/i18n , https://nodered.org/docs/creating-nodes/resources

## Message catalogs (i18n)

Only for nodes packaged as proper modules. For each node file listed in `package.json`, put locale
files **in a `locales` directory next to the node's `.js` file**:

```
myNode/locales/<language>/my-node.json   # message catalog
myNode/locales/<language>/my-node.html   # translated help text
```

Default language is `en-US`. The catalog file name matches the node file's base name.

Catalog:

```json
{ "myNode": { "message1": "This is my first message", "message2": "This is my second message" } }
```

It loads under the namespace `<module-name>/<node-key>` (e.g. `my-node-module/myNode`). Core nodes use
the `node-red` namespace.

### Runtime

```javascript
console.log(RED._("myNode.message1"));            // pre-scoped to the node's namespace
node.status({ fill: "green", shape: "dot", text: "myNode.status.ready" });   // message id as status text
node.status({ fill: "green", shape: "dot", text: "node-red:common.status.connected" }); // core catalog
```

### Editor

```html
<span data-i18n="myNode.label.foo"></span>
<input type="text" data-i18n="[placeholder]myNode.placeholder.foo">
<a href="#" data-i18n="[title]myNode.label.linkTitle;myNode.label.linkText"></a>
```

Inside node definition functions (e.g. `oneditprepare`) use `this._("myNode.label.foo")`.

## Editor resources (Node-RED >= 1.3)

A top-level `resources/` directory in the module is served at
`/resources/<module-name>/<path>` (scoped: `/resources/@scope/node-red-contrib-x/<path>`).

```
node-red-node-example
 |- resources/ (image.png, library.js)
 |- example-node.js
 |- example-node.html
 \- package.json
```

In editor HTML use **relative** URLs without a leading slash so Node-RED's configured root path works:

```html
<img src="resources/node-red-node-example/image.png" />
<script src="resources/node-red-node-example/library.js"></script>
```

Before 1.3 a node had to create custom HTTP admin endpoints for this.
