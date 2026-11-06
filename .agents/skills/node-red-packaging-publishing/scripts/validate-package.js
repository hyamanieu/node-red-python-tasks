#!/usr/bin/env node
/*
 * validate-package.js: static checks for a Node-RED node package.
 * Usage: node validate-package.js <package-dir>
 * Dependency-free (Node.js >= 18). Exit code 1 if errors were found.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2] || '.');
const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const exists = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, 'utf8');

const pkgPath = path.join(dir, 'package.json');
if (!exists(pkgPath)) {
    console.error('ERROR: no package.json in ' + dir);
    process.exit(1);
}

let pkg;
try { pkg = JSON.parse(read(pkgPath)); } catch (e) {
    console.error('ERROR: package.json is not valid JSON: ' + e.message);
    process.exit(1);
}

// --- package.json ---------------------------------------------------------
if (!pkg.name) err('package.json: missing "name"');
else if (!pkg.name.startsWith('@')) warn('package.json: name is not scoped; new packages should use a scoped name such as @scope/node-red-xyz');
if (pkg.name && /example-lower-case/.test(pkg.name)) warn('package.json: tutorial example package; do NOT publish it to npm');
if (!pkg.version) err('package.json: missing "version"');
if (!pkg.description) warn('package.json: missing "description"');
if (!pkg.license) warn('package.json: missing "license"');
if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes('node-red')) {
    warn('package.json: "keywords" lacks "node-red" (add only once the node is stable and documented)');
}

const nr = pkg['node-red'];
if (!nr || typeof nr !== 'object') {
    err('package.json: missing "node-red" section');
} else {
    if (!nr.version) warn('package.json: "node-red.version" not set; declare supported Node-RED versions, e.g. ">=2.0.0"');
    if (!nr.nodes || typeof nr.nodes !== 'object' || Object.keys(nr.nodes).length === 0) {
        err('package.json: "node-red.nodes" must map names to .js files');
    }
}

// --- node files -----------------------------------------------------------
const registerRe = /RED\.nodes\.registerType\(\s*(['"`])([^'"`]+)\1/g;
const allTypes = new Set();
const seenFiles = new Set();

for (const [key, rel] of Object.entries((nr && nr.nodes) || {})) {
    const jsPath = path.join(dir, rel);
    if (seenFiles.has(jsPath)) { warn(`node-red.nodes: file listed more than once: ${rel}`); continue; }
    seenFiles.add(jsPath);
    if (!exists(jsPath)) { err(`node-red.nodes["${key}"]: file not found: ${rel}`); continue; }

    const js = read(jsPath);
    const htmlPath = jsPath.replace(/\.js$/, '.html');
    const jsTypes = [...js.matchAll(registerRe)].map((m) => m[2]);
    if (!/module\.exports/.test(js)) err(`${rel}: does not export a function (module.exports = function (RED) {...})`);
    if (jsTypes.length === 0 && !/registerSubflow/.test(js)) err(`${rel}: no RED.nodes.registerType call found`);
    if (!/createNode\s*\(/.test(js) && !/registerSubflow/.test(js)) err(`${rel}: RED.nodes.createNode is never called`);
    if (/\.on\(\s*['"]input['"]/.test(js) && !/done\s*\(/.test(js)) warn(`${rel}: input handler never calls done(); use (msg, send, done)`);
    if (/setInterval|setTimeout|\.connect\(|createServer|\.listen\(/.test(js) && !/on\(\s*['"]close['"]/.test(js)) {
        warn(`${rel}: timers/connections detected but no 'close' handler; clean up on redeploy`);
    }
    if (/process\.exit\(/.test(js)) err(`${rel}: process.exit() must never be called from a node`);

    if (!exists(htmlPath)) {
        if (!/registerSubflow/.test(js)) err(`${rel}: matching HTML file not found (${path.relative(dir, htmlPath)})`);
        continue;
    }
    const html = read(htmlPath);
    const htmlTypes = [...html.matchAll(registerRe)].map((m) => m[2]);
    const tpl = new Set([...html.matchAll(/data-template-name\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
    const help = new Set([...html.matchAll(/data-help-name\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));

    for (const t of jsTypes) {
        allTypes.add(t);
        if (!htmlTypes.includes(t)) err(`type "${t}": registered in ${rel} but not in the HTML file`);
        if (!tpl.has(t)) err(`type "${t}": missing <script data-template-name="${t}"> in HTML`);
        if (!help.has(t)) warn(`type "${t}": missing <script data-help-name="${t}"> help text`);
    }
    for (const t of htmlTypes) {
        if (!jsTypes.includes(t)) err(`type "${t}": registered in HTML but not in ${rel}`);
    }
    if (!/['"]use strict['"]/.test(html)) warn(`${path.relative(dir, htmlPath)}: editor code not wrapped in an IIFE with 'use strict'`);

    // reserved property names inside defaults: { ... }
    const dm = html.match(/defaults\s*:\s*\{([\s\S]*?)\n\s*\}\s*,/);
    if (dm) {
        const names = [...dm[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*\{/gm)].map((m) => m[1]);
        for (const n of names) {
            if (n.length === 1) err(`${path.relative(dir, htmlPath)}: property "${n}" is a reserved single-character name`);
            if (['id', 'type', 'wires', 'inputs'].includes(n)) err(`${path.relative(dir, htmlPath)}: property "${n}" is reserved`);
            if (n === 'outputs') warn(`${path.relative(dir, htmlPath)}: "outputs" in defaults is only valid for a configurable output count`);
        }
        if (!names.includes('name') && !/category\s*:\s*['"]config['"]/.test(html)) warn(`${path.relative(dir, htmlPath)}: no "name" property in defaults`);
    }
    if (/credentials\s*:/.test(html) && !/credentials\s*:/.test(js)) err(`${rel}: HTML declares credentials but registerType in .js has none`);
    if (/localhost:\d+|href=["']\//.test(html) && /resources\//.test(html) === false && /src=["']\//.test(html)) {
        warn(`${path.relative(dir, htmlPath)}: absolute URL for editor resources; use relative URLs without a leading "/"`);
    }
}

// --- supporting files -----------------------------------------------------
if (!exists(path.join(dir, 'README.md'))) warn('missing README.md');
if (!['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE'].some((f) => exists(path.join(dir, f)))) warn('missing LICENSE file');

const examplesDir = path.join(dir, 'examples');
if (exists(examplesDir)) {
    for (const f of fs.readdirSync(examplesDir)) {
        if (!f.endsWith('.json')) { warn(`examples/${f}: examples should be .json flow files`); continue; }
        try { JSON.parse(read(path.join(examplesDir, f))); } catch (e) { err(`examples/${f}: invalid JSON (${e.message})`); }
    }
} else {
    // detect misplaced examples folder
    for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
        if (sub.isDirectory() && sub.name !== 'node_modules' && exists(path.join(dir, sub.name, 'examples'))) {
            err(`"${sub.name}/examples" found: the examples folder must be at the package root`);
        }
    }
    warn('no examples/ folder (optional, but recommended)');
}

for (const rel of Object.values((nr && nr.nodes) || {})) {
    const nodeDir = path.dirname(path.join(dir, rel));
    const loc = path.join(nodeDir, 'locales');
    if (exists(loc)) {
        const base = path.basename(rel, '.js');
        for (const lang of fs.readdirSync(loc)) {
            const cat = path.join(loc, lang, base + '.json');
            if (!exists(cat)) warn(`locales/${lang}: expected catalog ${base}.json next to ${rel}`);
            else { try { JSON.parse(read(cat)); } catch (e) { err(`${path.relative(dir, cat)}: invalid JSON`); } }
        }
    }
}

// --- report ---------------------------------------------------------------
console.log(`Package: ${pkg.name || '(unnamed)'}  Node types: ${[...allTypes].join(', ') || '(none)'}`);
for (const w of warnings) console.log('WARN  ' + w);
for (const e of errors) console.log('ERROR ' + e);
console.log(`${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
