# Node help style guide

Source: https://nodered.org/docs/creating-nodes/help-style-guide

Help appears in the Info tab. It must give users everything needed to use the node, without assuming
they are experienced developers or know the system the node exposes.

## Structure

1. **Intro** (no heading): 2-3 lines. The first `<p>` is the palette tooltip.
2. **Inputs** (`<h3>`): message properties the node reads, with types; mark optional ones.
3. **Outputs** (`<h3>`): message properties it sends; one list per output if multiple.
4. **Details** (`<h3>`): how to use it; sub-headings with `<h4>`.
5. **References** (`<h3>`): links to external docs, repository or npm page.

## HTML form

```html
<script type="text/html" data-help-name="node-type">
<p>Connects to a MQTT broker and publishes messages.</p>

<h3>Inputs</h3>
    <dl class="message-properties">
        <dt>payload <span class="property-type">string | buffer</span></dt>
        <dd>the payload of the message to publish.</dd>
        <dt class="optional">topic <span class="property-type">string</span></dt>
        <dd>the MQTT topic to publish to.</dd>
    </dl>

<h3>Outputs</h3>
    <ol class="node-ports">
        <li>Standard output
            <dl class="message-properties">
                <dt>payload <span class="property-type">string</span></dt>
                <dd>the standard output of the command.</dd>
            </dl>
        </li>
        <li>Standard error
            <dl class="message-properties">
                <dt>payload <span class="property-type">string</span></dt>
                <dd>the standard error of the command.</dd>
            </dl>
        </li>
    </ol>

<h3>Details</h3>
    <p><code>msg.payload</code> is used as the payload of the published message.</p>

<h3>References</h3>
    <ul><li><a href="https://example.com">Docs</a> - description</li></ul>
</script>
```

Rules:
- Property lists: `<dl class="message-properties">` with `<dt>` (name + optional
  `<span class="property-type">`) and `<dd>` (brief description). Optional property: `<dt class="optional">`.
- Multiple outputs: wrap per-output lists in `<ol class="node-ports">`; a single output uses just the `<dl>`.
- Refer to message properties outside lists as `<code>msg.payload</code>`.
- No other styling markup (`<b>`, `<i>`) in the body.

## Markdown form (since Node-RED 2.1.0)

Use `type="text/markdown"`. Markdown is whitespace sensitive: **no leading whitespace** on any line
inside the `<script>` tag.

```
<script type="text/markdown" data-help-name="node-type">
Connects to a MQTT broker and publishes messages.

### Inputs

: payload (string | buffer) :  the payload of the message to publish.
: *topic* (string)          :  the MQTT topic to publish to.

### Outputs

1. Standard output
: payload (string) : the standard output of the command.

2. Standard error
: payload (string) : the standard error of the command.

### Details

`msg.payload` is used as the payload of the published message.

### References

 - [Docs](https://example.com) - description
</script>
```

Optional properties are written in italics (`*topic*`). Section headings are `###`; sub-sections `####`.
