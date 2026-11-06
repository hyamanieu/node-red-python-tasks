---
name: node-red-editor-ui
description: Write or review the HTML file of a Node-RED node, covering RED.nodes.registerType in the editor, the node definition (category, defaults, inputs, outputs, icon, color, label), property validation, the edit dialog template, TypedInput and code editors, oneditprepare/oneditsave hooks, and the Info-tab help text. Use when building or changing anything the user sees in the Node-RED editor, palette, edit dialog or help sidebar.
license: Apache-2.0
metadata:
  source: https://nodered.org/docs/creating-nodes/node-html
---

# Editor HTML file

The `.html` file has three parts, each in its own `<script>` tag:

1. **Node definition** (`text/javascript`): registered with the editor.
2. **Edit template** (`text/html`, `data-template-name="<type>"`): the edit dialog content.
3. **Help text** (`text/html` or, since 2.1.0, `text/markdown`, `data-help-name="<type>"`): Info tab.

```html
<script type="text/javascript">
    (function () {            // isolate to avoid global leaks
        'use strict';
        RED.nodes.registerType('sample', {
            category: 'function',
            color: '#a6bbcf',
            defaults: {
                name:   { value: "" },
                prefix: { value: "", required: true }
            },
            inputs: 1,
            outputs: 1,
            icon: "file.svg",
            label: function () { return this.name || "sample"; }
        });
    }());
</script>

<script type="text/html" data-template-name="sample">
    <div class="form-row">
        <label for="node-input-name"><i class="fa fa-tag"></i> Name</label>
        <input type="text" id="node-input-name" placeholder="Name">
    </div>
    <div class="form-row">
        <label for="node-input-prefix"><i class="fa fa-tag"></i> Prefix</label>
        <input type="text" id="node-input-prefix">
    </div>
</script>

<script type="text/html" data-help-name="sample">
    <p>One-line summary (used as the palette tooltip).</p>
</script>
```

The type string must equal the one registered in the `.js` file.

## Node definition fields

| Field | Type | Meaning |
|---|---|---|
| `category` | string | Palette category (`config` for configuration nodes) |
| `defaults` | object | Editable properties (see below) |
| `credentials` | object | Secret properties (see `node-red-config-and-credentials`) |
| `inputs` | 0 or 1 | Number of input ports |
| `outputs` | number >= 0 | Number of output ports |
| `color` | string | Background colour |
| `paletteLabel` / `label` / `labelStyle` | string or function | Palette label, workspace label, label CSS class |
| `inputLabels` / `outputLabels` | string, array or function | Hover labels on ports |
| `icon` | string or function | Icon file or Font Awesome |
| `align` | `"right"` | Right-align icon/label (convention for end-of-flow nodes) |
| `button` | object | Button on node edge (avoid; the editor is not a dashboard) |
| `oneditprepare`, `oneditsave`, `oneditcancel`, `oneditdelete`, `oneditresize` | function | Edit dialog hooks |
| `onpaletteadd`, `onpaletteremove` | function | Palette lifecycle hooks |

Appearance details (stock icons, colours, labels, buttons): `references/appearance.md`.

## Properties (`defaults`)

Each entry is an object with:

- `value`: default for new nodes
- `required`: true = invalid when null or empty string
- `validate`: function(value) returning true/false; `this` is the node (use form element value when
  the dialog is open, `this.prop` as fallback)
- `type`: config node type this property points to

Built-in validators: `RED.validators.number()`, `RED.validators.regex(re)`.

```javascript
defaults: {
    minimumLength: { value: 0, validate: RED.validators.number() },
    custom: { value: "", validate: function (v) {
        const min = $("#node-input-minimumLength").length
            ? $("#node-input-minimumLength").val() : this.minimumLength;
        return v.length > min;
    } }
}
```

**Reserved names (never use):** any single character (`x y z d g l` are in use), `id`, `type`,
`wires`, `inputs`, `outputs`. `outputs` is allowed in `defaults` only to make the output count
configurable (see the Function node).

In the edit dialog each property needs an element with `id="node-input-<property>"`
(`node-config-input-<property>` for configuration nodes). The editor fills it from the property and
reads it back on OK. Use `text` inputs for strings/numbers, `checkbox` for booleans, `<select>` for
fixed choices.

## Custom edit behaviour

Use hooks when a property cannot be edited with a plain input:

- `oneditprepare`: before the dialog is shown (init TypedInput, editors, event handlers)
- `oneditsave`: on OK (write custom state back to properties, destroy editors)
- `oneditcancel`: on cancel (destroy editors)
- `oneditdelete`: delete button in a config node dialog
- `oneditresize`: dialog resized

Edit dialog widgets (buttons, `TypedInput`, multi-line code editor): `references/edit-dialog.md`.

## Help text (summary)

First `<p>` = palette tooltip, 2-3 lines max. Then `<h3>` sections: **Inputs**, **Outputs**,
**Details**, **References**. Message property lists use `<dl class="message-properties">`;
multiple outputs use `<ol class="node-ports">`. Prefix message properties with `msg.` in `<code>`.
Full rules and a markdown variant: `references/help-style-guide.md`.

## Using resources and i18n in the editor

- Images/scripts shipped in a top-level `resources/` folder: use relative URLs
  (`resources/<module>/file.png`, no leading slash). See `node-red-packaging-publishing`.
- `data-i18n` attributes and `this._()` for translations: see the same skill's i18n reference.

## Review checklist

- [ ] type string matches `.js` and package.json
- [ ] `defaults.name` present and used by `label`
- [ ] every `defaults`/`credentials` key has a matching `node-input-<key>` element
- [ ] required/validated fields marked; no reserved property names
- [ ] icon exists (stock, custom in `icons/`, or `font-awesome/fa-...`); colour fits the muted palette
- [ ] help documents every msg property read and written; first paragraph is a good tooltip
- [ ] editor widgets created in `oneditprepare` are destroyed in `oneditsave`/`oneditcancel`
