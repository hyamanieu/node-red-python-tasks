#!/usr/bin/env node
/*
 * scaffold.js: generate a minimal, working Node-RED node package.
 * Dependency-free (Node.js >= 18).
 *
 * Usage:
 *   node scaffold.js --name @scope/node-red-contrib-hello --type hello --out ./node-red-contrib-hello
 *
 * Options:
 *   --name         npm package name (scoped recommended)              [required]
 *   --type         node type, lowercase letters/digits/hyphens        [required]
 *   --out          output directory                                    [default ./<package basename>]
 *   --category     palette category                                    [default function]
 *   --description  package description
 *   --author       package author
 *   --license      SPDX id; MIT text is generated, others need a manual LICENSE file [default MIT]
 *   --node-red     supported Node-RED semver range                     [default >=2.0.0]
 *   --force        write into a non-empty directory
 *   --help
 */
'use strict';
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const k = a.slice(2);
        if (k === 'force' || k === 'help') { out[k] = true; continue; }
        out[k] = argv[++i];
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.name || !args.type) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\n?/, '').replace(/^ \* ?/gm, ''));
    process.exit(args.help ? 0 : 1);
}

const TYPE = args.type;
if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(TYPE)) {
    console.error('ERROR: --type must be lowercase letters/digits separated by single hyphens (e.g. "my-node")');
    process.exit(1);
}
if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(args.name)) {
    console.error('ERROR: --name is not a valid npm package name');
    process.exit(1);
}
if (/lower-case/.test(TYPE) && /example/.test(args.name)) {
    console.error('NOTE: the tutorial lower-case example must not be published to npm.');
}

const base = args.name.split('/').pop();
const outDir = path.resolve(args.out || ('./' + base));
const category = args.category || 'function';
const license = args.license || 'MIT';
const nrRange = args['node-red'] || '>=2.0.0';
const description = args.description || ('A Node-RED node: ' + TYPE);
const author = args.author || '';
const ctor = TYPE.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join('') + 'Node';
const title = TYPE.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join(' ');

if (fs.existsSync(outDir) && fs.readdirSync(outDir).length && !args.force) {
    console.error('ERROR: ' + outDir + ' is not empty (use --force to write anyway)');
    process.exit(1);
}

const fill = (s) => s
    .replace(/\{\{TYPE\}\}/g, TYPE)
    .replace(/\{\{CTOR\}\}/g, ctor)
    .replace(/\{\{TITLE\}\}/g, title)
    .replace(/\{\{NAME\}\}/g, args.name)
    .replace(/\{\{CATEGORY\}\}/g, category)
    .replace(/\{\{DESC\}\}/g, description)
    .replace(/\{\{YEAR\}\}/g, String(new Date().getFullYear()))
    .replace(/\{\{AUTHOR\}\}/g, author);

const files = {};

files['package.json'] = JSON.stringify({
    name: args.name,
    version: '0.0.1',
    description: description,
    author: author || undefined,
    license: license,
    keywords: [],            // add "node-red" only when the node is stable and documented
    dependencies: {},
    devDependencies: {
        'mocha': '^10.0.0',
        'node-red': '^4.0.0',
        'node-red-node-test-helper': '^0.3.4',
        'should': '^13.2.3'
    },
    scripts: { test: 'mocha "test/**/*_spec.js"' },
    'node-red': {
        version: nrRange,
        nodes: { [TYPE]: TYPE + '/' + TYPE + '.js' }
    }
}, null, 4) + '\n';

files[TYPE + '/' + TYPE + '.js'] = fill(`module.exports = function (RED) {
    function {{CTOR}}(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.prefix = config.prefix || "";

        node.on('input', function (msg, send, done) {
            try {
                // Be forgiving about payload types.
                let value = msg.payload;
                if (Buffer.isBuffer(value)) { value = value.toString(); }
                else if (value !== null && typeof value === 'object') { value = JSON.stringify(value); }
                else if (value === undefined || value === null) { value = ""; }
                msg.payload = node.prefix + String(value);   // reuse msg so other properties survive
                send(msg);
                done();
            } catch (err) {
                done(err);   // lets a Catch node on the same tab handle it
            }
        });

        node.on('close', function (removed, done) {
            // release timers, sockets, listeners created in the constructor
            done();
        });
    }
    RED.nodes.registerType("{{TYPE}}", {{CTOR}});
};
`);

files[TYPE + '/' + TYPE + '.html'] = fill(`<script type="text/javascript">
    // Isolate the code in a function to avoid global variable leaks
    (function () {
        'use strict';

        RED.nodes.registerType('{{TYPE}}', {
            category: '{{CATEGORY}}',
            color: '#a6bbcf',
            defaults: {
                name: { value: "" },
                prefix: { value: "" }
            },
            inputs: 1,
            outputs: 1,
            icon: "file.svg",
            label: function () {
                return this.name || "{{TYPE}}";
            }
        });
    }());
</script>

<script type="text/html" data-template-name="{{TYPE}}">
    <div class="form-row">
        <label for="node-input-name"><i class="fa fa-tag"></i> Name</label>
        <input type="text" id="node-input-name" placeholder="Name">
    </div>
    <div class="form-row">
        <label for="node-input-prefix"><i class="fa fa-tag"></i> Prefix</label>
        <input type="text" id="node-input-prefix" placeholder="Text added before the payload">
    </div>
</script>

<script type="text/html" data-help-name="{{TYPE}}">
<p>Adds a prefix to the message payload.</p>

<h3>Inputs</h3>
    <dl class="message-properties">
        <dt>payload <span class="property-type">string | buffer | object | number | boolean</span></dt>
        <dd>the value to prefix. Non-string values are converted to text.</dd>
    </dl>

<h3>Outputs</h3>
    <dl class="message-properties">
        <dt>payload <span class="property-type">string</span></dt>
        <dd>the prefix followed by the original payload.</dd>
    </dl>

<h3>Details</h3>
    <p>The prefix is set in the node's edit dialog. Other message properties are passed through unchanged.</p>
</script>
`);

files['test/' + TYPE + '_spec.js'] = fill(`const helper = require("node-red-node-test-helper");
require("should");
const node = require("../{{TYPE}}/{{TYPE}}.js");

helper.init(require.resolve("node-red"));

describe("{{TYPE}} node", function () {
    beforeEach(function (done) { helper.startServer(done); });
    afterEach(function (done) {
        helper.unload().then(function () { helper.stopServer(done); });
    });

    it("should be loaded", async function () {
        const flow = [{ id: "n1", type: "{{TYPE}}", name: "test name" }];
        await helper.load(node, flow);
        helper.getNode("n1").should.have.property("name", "test name");
    });

    it("should prefix the payload and keep other properties", function (done) {
        const flow = [
            { id: "n1", type: "{{TYPE}}", prefix: "hi ", wires: [["n2"]] },
            { id: "n2", type: "helper" }
        ];
        helper.load(node, flow).then(function () {
            const n1 = helper.getNode("n1");
            helper.getNode("n2").on("input", function (msg) {
                try {
                    msg.should.have.property("payload", "hi world");
                    msg.should.have.property("topic", "t");
                    done();
                } catch (e) { done(e); }
            });
            n1.receive({ payload: "world", topic: "t" });
        });
    });
});
`);

files['examples/' + title + '.json'] = JSON.stringify([
    { id: 'c1', type: 'comment', z: 'f1', name: 'Send a message through the {{TYPE}} node'.replace('{{TYPE}}', TYPE), info: '', x: 220, y: 60, wires: [] },
    { id: 'i1', type: 'inject', z: 'f1', name: '', props: [{ p: 'payload' }], payload: 'world', payloadType: 'str', x: 140, y: 120, wires: [['n1']] },
    { id: 'n1', type: TYPE, z: 'f1', name: '', prefix: 'hello ', x: 320, y: 120, wires: [['d1']] },
    { id: 'd1', type: 'debug', z: 'f1', name: '', active: true, tosidebar: true, console: false, complete: 'payload', x: 500, y: 120, wires: [] },
    { id: 'f1', type: 'tab', label: title + ' example', disabled: false, info: '' }
], null, 4) + '\n';

files['README.md'] = fill(`# {{NAME}}

{{DESC}}

## Install

Run the following in your Node-RED user directory (typically \`~/.node-red\`):

    npm install {{NAME}}

## Usage

The **{{TYPE}}** node adds a prefix to \`msg.payload\`. See the node's help in the Info sidebar and the
example flow under Import > Examples.

## Development

    npm install
    npm test

To try it in a local Node-RED instance:

    cd ~/.node-red
    npm install /path/to/this/folder

## License

{{TITLE}} is released under the ${license} license.
`);

files['.gitignore'] = 'node_modules/\n*.log\n.DS_Store\n';

if (license === 'MIT') {
    files['LICENSE'] = fill(`MIT License

Copyright (c) {{YEAR}} {{AUTHOR}}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`);
}

for (const [rel, content] of Object.entries(files)) {
    const p = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
}

console.log('Created Node-RED node package in ' + outDir);
Object.keys(files).forEach((f) => console.log('  ' + f));
console.log('\nNext steps:');
console.log('  cd ' + outDir + ' && npm install && npm test');
console.log('  node <skills>/node-red-packaging-publishing/scripts/validate-package.js .');
if (license !== 'MIT') console.log('  Add a LICENSE file for ' + license + ' (not generated).');
console.log('  Add the "node-red" keyword to package.json only when the node is stable and documented.');
