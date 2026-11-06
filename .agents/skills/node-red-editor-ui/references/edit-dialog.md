# Node edit dialog

Source: https://nodered.org/docs/creating-nodes/edit-dialog

The dialog should be intuitive and consistent with core nodes. It lives in:

```html
<script type="text/html" data-template-name="node-type"> ... </script>
```

Rows:

```html
<div class="form-row">
    <label for="node-input-name"><i class="fa fa-tag"></i> Name</label>
    <input type="text" id="node-input-name" placeholder="Name">
</div>
<div class="form-tips"><b>Tip:</b> short helpful hint.</div>
```

- Row = `<div class="form-row">`; label with a Font Awesome 4.7 icon + property name, then the input.
- Input id: `node-input-<property>`; for configuration nodes `node-config-input-<property>`.
- Input types: `text` (string/number), `checkbox` (boolean), `<select>` (restricted choices).

## Buttons

`<button type="button" class="red-ui-button">Button</button>`; small: add `red-ui-button-small`.
Toggle group: wrap in `<span class="button-group">` with buttons of class `red-ui-button toggle`
(avoid whitespace between buttons); add the click handling that moves the `selected` class in
`oneditprepare`.

## TypedInput

A jQuery widget letting the user choose the type of a value. Initialise in `oneditprepare`.
API: https://nodered.org/docs/api/ui/typedInput/

```javascript
// string / number / boolean, with a hidden input storing the chosen type
$("#node-input-example1").typedInput({
    type: "str", types: ["str", "num", "bool"], typeField: "#node-input-example1-type"
});
// JSON
$("#node-input-example2").typedInput({ type: "json", types: ["json"] });
// msg / flow / global property
$("#node-input-example3").typedInput({
    type: "msg", types: ["msg", "flow", "global"], typeField: "#node-input-example3-type"
});
// select box (add multiple: "true" for multi-select, value is comma-separated)
$("#node-input-example4").typedInput({
    types: [{ value: "fruit", options: [
        { value: "apple", label: "Apple" }, { value: "banana", label: "Banana" } ] }]
});
```

When multiple types are allowed, add a hidden `<input type="hidden" id="node-input-example1-type">`
and a matching property (`example1Type`) in `defaults`.

## Multi-line text editor

Ace-based (or Monaco if enabled in user settings). Placeholder needs class `node-text-editor` and a height:

```html
<div style="height: 250px; min-height:150px;" class="node-text-editor" id="node-input-example-editor"></div>
```

```javascript
oneditprepare: function () {
    this.editor = RED.editor.createEditor({
        id: 'node-input-example-editor', mode: 'ace/mode/text', value: this.exampleText
    });
},
oneditsave:   function () { this.exampleText = this.editor.getValue(); this.editor.destroy(); delete this.editor; },
oneditcancel: function () { this.editor.destroy(); delete this.editor; }
```
