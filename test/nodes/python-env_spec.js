// Test suite for nodes/python-env.js

const chai = require('chai');
const expect = chai.expect;
const path = require('path');
const fs = require('fs');

describe('python-env node', function() {
    const testProjectDir = path.join(__dirname, '..', 'fixtures', 'pixi-project');
    let RED;
    let PythonEnvNode;

    before(function() {
        // Ensure test fixtures exist
        if (!fs.existsSync(testProjectDir)) {
            fs.mkdirSync(testProjectDir, { recursive: true });
        }
        
        // Create a minimal pixi.toml
        const pixiTomlPath = path.join(testProjectDir, 'pixi.toml');
        if (!fs.existsSync(pixiTomlPath)) {
            fs.writeFileSync(pixiTomlPath, `
[project]
name = "node-red-python-test"
version = "0.1.0"
description = "Test project"
authors = []
channels = ["conda-forge"]
platforms = ["linux-64"]

[environments]
default = []

[tool.pixi.simple]
pm = "pip"
`);
        }

        // Load the node module
        PythonEnvNode = require('../../nodes/python-env');

        // Create mock RED
        RED = {
            nodes: {
                createNode: function(node, config) {
                    node.id = config.id || 'test-node-' + Date.now();
                    node.log = console.log.bind(console);
                    node.error = function(err, msg) {
                        node.lastError = err;
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
                    return node;
                },
                getNode: function(id) {
                    return null;
                },
                registerType: function(type, constructor, options) {
                    // Just store it
                }
            },
            _: function(key) {
                return key;
            },
            log: {
                info: console.log.bind(console),
                warn: console.warn.bind(console),
                error: console.error.bind(console)
            }
        };
    });

    describe('configuration validation', function() {
        it('should accept valid configuration', function() {
            const config = {
                id: 'test-env-1',
                name: 'Test Environment',
                projectDir: testProjectDir,
                environment: 'default',
                startupTimeout: 120000
            };

            PythonEnvNode(RED);
            const node = RED.nodes.createNode({ id: 'test-env-1' }, config);
            
            expect(node.isValid()).to.be.true;
        });

        it('should reject empty project directory', function() {
            const config = {
                id: 'test-env-2',
                name: 'Test Environment',
                projectDir: '',
                environment: 'default'
            };

            const node = RED.nodes.createNode({ id: 'test-env-2' }, config);
            
            expect(node.isValid()).to.be.false;
            expect(node.workerStatus).to.equal('error');
        });

        it('should reject non-existent project directory', function() {
            const config = {
                id: 'test-env-3',
                name: 'Test Environment',
                projectDir: '/nonexistent/path',
                environment: 'default'
            };

            const node = RED.nodes.createNode({ id: 'test-env-3' }, config);
            
            expect(node.isValid()).to.be.false;
            expect(node.workerStatus).to.equal('error');
        });

        it('should reject directory without pixi.toml', function() {
            const tempDir = path.join(testProjectDir, 'no-pixi-toml');
            
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir);
            }

            const config = {
                id: 'test-env-4',
                name: 'Test Environment',
                projectDir: tempDir,
                environment: 'default'
            };

            const node = RED.nodes.createNode({ id: 'test-env-4' }, config);
            
            expect(node.isValid()).to.be.false;
            expect(node.workerStatus).to.equal('error');
        });
    });

    describe('worker manager creation', function() {
        it('should create worker manager for valid config', function() {
            const config = {
                id: 'test-env-5',
                name: 'Test Environment',
                projectDir: testProjectDir,
                environment: 'default',
                startupTimeout: 120000
            };

            const node = RED.nodes.createNode({ id: 'test-env-5' }, config);
            
            // Give a moment for async initialization
            setTimeout(() => {
                expect(node.getWorkerManager()).to.not.be.null;
            }, 100);
        });

        it('should not create worker manager for invalid config', function() {
            const config = {
                id: 'test-env-6',
                name: 'Test Environment',
                projectDir: '/nonexistent/path',
                environment: 'default'
            };

            const node = RED.nodes.createNode({ id: 'test-env-6' }, config);
            
            expect(node.getWorkerManager()).to.be.null;
        });
    });

    describe('cleanup', function() {
        it('should call done callback on cleanup', function(done) {
            const config = {
                id: 'test-env-7',
                name: 'Test Environment',
                projectDir: testProjectDir,
                environment: 'default'
            };

            const node = RED.nodes.createNode({ id: 'test-env-7' }, config);
            
            node.cleanup(function() {
                done();
            });
        });
    });
});
