# Node appearance (icon, colour, labels, buttons)

Source: https://nodered.org/docs/creating-nodes/appearance

## Icon

`icon` is a string or a function (evaluated on load and after edit; in the palette `this` is not a
node instance, so it must always return a valid value).

Options:
- Stock icon name: `alert.svg arrow-in.svg bridge-dash.svg bridge.svg db.svg debug.svg envelope.svg
  feed.svg file.svg function.svg hash.svg inject.svg light.svg serial.svg template.svg white-globe.svg`
- Custom icon: file in an `icons/` directory next to the node `.js`/`.html`. Filename must be unique
  across all installed nodes. White on transparent, 2:3 aspect ratio, minimum 40 x 60.
- Font Awesome 4.7: `icon: "font-awesome/fa-automobile"`

Users can override the icon in the node's Appearance tab, unless the node has an `icon` property in
`defaults`.

## Colour

`color: "#a6bbcf"`. Use the muted palette. Common values: `#3FADB5 #87A980 #A6BBCF #AAAA66 #C0C0C0
#C0DEED #C7E9C0 #D7D7A0 #D8BFD8 #DAC4B4 #DEB887 #DEBD5C #E2D96E #E6E0F8 #E7E7AE #E9967A #F3B567
#FDD0A2 #FDF0C2 #FFAAAA #FFCC66 #FFF0F0 #FFFFFF`.

## Labels

```javascript
label: function () { return this.name || "lower-case"; },       // workspace label
paletteLabel: "my node",                                          // palette (string or function, evaluated once)
labelStyle: function () { return this.name ? "node_label_italic" : ""; },  // CSS class
align: 'right',                                                   // end-of-flow nodes
inputLabels: "parameter for input",
outputLabels: ["stdout", "stderr", "rc"],                         // or function(index)
```

- Credentials cannot be used in the `label` function.
- Port labels are static; they cannot be driven by `msg` properties. Users may override them in the
  node's settings.
- `labelStyle` currently takes a CSS class; the predefined ones are `node_label` (default) and
  `node_label_italic`.

## Buttons

Avoid buttons: the editor is not a dashboard (Inject and Debug are special cases).

```javascript
button: {
    onclick: function () { },
    enabled: function () { return !this.changed; },   // optional
    visible: function () { return this.hasButton; },  // optional
    toggle: "buttonState"                             // optional: boolean property in defaults
}
```
