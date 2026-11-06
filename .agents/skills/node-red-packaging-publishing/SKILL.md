---
name: node-red-packaging-publishing
description: Package and publish a Node-RED node as an npm module, covering naming (scoped names), directory layout, package.json node-red section and version range, keywords, README, LICENSE, example flows, internationalisation (locales, message catalogs), editor resources, npm publishing, and submission to the Node-RED Flow Library. Includes a validator script. Use when preparing a node for release, fixing package.json, adding examples or translations, or checking a node package for mistakes.
license: Apache-2.0
compatibility: validate-package.js requires Node.js >= 18 and has no dependencies.
metadata:
  source: https://nodered.org/docs/creating-nodes/packaging
---

# Packaging and publishing

## Naming (rules since 31 Jan 2022)

New packages should use a **scoped name**, e.g. `@myScope/node-red-sample` (user or organisation
scope). Scoped packages have no further naming requirements (`@myScope/sample` is allowed) but
including `node-red` in the name helps association. Forking an existing package for a fix may keep the
name under your own scope, but forking is a last resort.

## Directory layout

```
├── LICENSE
├── README.md
├── package.json
├── examples/            # must be at the package root
│   ├── example-1.json
│   └── example-2.json
├── resources/           # optional: served to the editor (Node-RED >= 1.3)
└── sample/
    ├── icons/my-icon.svg
    ├── locales/en-US/sample.json   # optional (i18n)
    ├── sample.html
    └── sample.js
```

Directory structure inside the package is otherwise free: several nodes can share a folder or each
have their own.

## package.json

```json
{
    "name": "@myScope/node-red-sample",
    "version": "0.0.1",
    "description": "A sample node for Node-RED",
    "dependencies": {},
    "keywords": ["node-red"],
    "license": "Apache-2.0",
    "node-red": {
        "version": ">=2.0.0",
        "nodes": { "sample": "sample/sample.js" }
    }
}
```

- `node-red.nodes`: map of `<name>: <path to .js>`. List a file once even if it registers several node types.
- `node-red.version`: semver range of supported Node-RED versions.
- Runtime dependencies go in `dependencies`.
- `keywords` should include `node-red` for npm discovery. **Do not add it until the node is stable,
  working and documented enough for others.**
- Optional but recommended: `engines`, `repository`, `author`, `bugs`, `files`.

## README.md

GitHub-flavoured markdown. Describe capabilities and prerequisites, extra instructions not in the
Info-tab help, and ideally a small example flow.

## LICENSE

Include a licence file so others know what they may do with the code.

## Example flows

Put flow JSON files in `examples/` at the package root. They appear under Import > Examples in the
editor. The filename (without `.json`) is the menu label (`My Great Example.json` shows as
"My Great Example"). Keep them short, include a **comment node** explaining the flow, and avoid
third-party nodes that need separate installation.

## Internationalisation and editor resources

See `references/i18n-and-resources.md` for message catalogs (`locales/<lang>/<file>.json|html`),
`RED._()`, `data-i18n`, and the `resources/` folder for images, scripts and CSS in the editor.

## Validate

```sh
node .agents/skills/node-red-packaging-publishing/scripts/validate-package.js <package-dir>
```

Checks: package.json `node-red.nodes` files exist; node types registered in `.js` and `.html` match
and each has a `data-template-name` and `data-help-name`; README/LICENSE/keywords/version range;
scoped name; examples folder placement; locales/icons folders; leftover tutorial names. Exit code is
non-zero on errors. Treat warnings as items to review, not necessarily blockers.

## Publish to npm

1. Test locally (`node-red-testing`), run `npm test`, run the validator.
2. Set `version`; add the `node-red` keyword only when ready.
3. Check package contents: `npm pack --dry-run`.
4. `npm login`, then `npm publish --access public` (required for the first publish of a scoped package).
5. Never publish the tutorial `lower-case` example.

Basic npm guidance: https://docs.npmjs.com/misc/developers

## Add to the Node-RED Flow Library

Since April 2020 the Flow Library no longer indexes npm automatically. Submit manually: use the `+`
button on https://flows.nodered.org, choose "node", and follow https://flows.nodered.org/add/node
(it repeats the requirements). To update, resubmit or use "request refresh" on the node's page
(visible when logged in). For help ask on https://discourse.nodered.org or https://nodered.org/slack.
