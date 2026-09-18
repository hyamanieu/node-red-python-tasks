// Test helper for Node-RED Python nodes

const path = require('path');
const fs = require('fs');

// Set up the test environment
module.exports = {
    // Get the path to the test fixtures
    getFixturesPath: function() {
        return path.join(__dirname, 'fixtures', 'pixi-project');
    },

    // Ensure test fixtures directory exists and has a pixi.toml
    ensureFixtures: function() {
        const fixturesPath = this.getFixturesPath();
        const pixiTomlPath = path.join(fixturesPath, 'pixi.toml');

        if (!fs.existsSync(fixturesPath)) {
            fs.mkdirSync(fixturesPath, { recursive: true });
        }

        if (!fs.existsSync(pixiTomlPath)) {
            // Create a minimal pixi.toml
            fs.writeFileSync(pixiTomlPath, `
[project]
name = "node-red-python-test"
version = "0.1.0"
description = "Test project for Node-RED Python nodes"
authors = []
channels = ["conda-forge"]
platforms = ["linux-64"]

[environments]
default = []

[tool.pixi.simple]
pm = "pip"
`);
        }

        return fixturesPath;
    },

    // Mock RED object for testing
    createMockRED: function() {
        const nodes = {};
        const nodeInstances = [];

        return {
            nodes: {
                createNode: function(node, config) {
                    node.id = config.id || 'test-node-' + Date.now();
                    node.log = console.log.bind(console);
                    node.error = function(err, msg) {
                        console.error('Node error:', err.message || err);
                    };
                    node.warn = console.warn.bind(console);
                    node.debug = console.log.bind(console);
                    node.trace = console.log.bind(console);
                    node.send = function(msg) {
                        node.lastSent = msg;
                    };
                    node.status = function(status) {
                        node.lastStatus = status;
                    };
                    
                    nodeInstances.push(node);
                    return node;
                },
                getNode: function(id) {
                    return nodes[id] || null;
                },
                registerType: function(type, constructor, options) {
                    nodes[type] = constructor;
                }
            },
            _: function(key) {
                // Simple i18n mock
                return key;
            },
            log: {
                info: console.log.bind(console),
                warn: console.warn.bind(console),
                error: console.error.bind(console),
                debug: console.log.bind(console),
                trace: console.log.bind(console)
            },
            // Get all node instances
            getNodeInstances: function() {
                return nodeInstances;
            },
            // Clear all node instances
            clearNodeInstances: function() {
                nodeInstances.length = 0;
            }
        };
    }
};
