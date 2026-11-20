// Test suite for the python-run node startup behaviour:
// the workspace config node is constructed before flow nodes but sets up its
// environment asynchronously, so a python-run node must not log
// "Invalid Python workspace configuration" on every restart while the
// workspace is still initializing — it waits for it instead.

const chai = require('chai');
const expect = chai.expect;
const path = require('path');
const fs = require('fs');
const os = require('os');

const runNodeModule = require('../../nodes/python-run');

describe('python-run node startup with an initializing workspace', function() {
    let constructors;
    let workspaceNode;

    function createMockRED() {
        constructors = {};
        return {
            nodes: {
                createNode: function(node, config) {
                    node.id = config.id || 'run-node-1';
                    node.log = function() {};
                    node.warn = function() {};
                    node.error = function(err, msg) {
                        node.lastError = err && err.message ? err.message : String(err);
                        node.lastErrorMsg = msg;
                        node.errorCount = (node.errorCount || 0) + 1;
                    };
                    node.debug = function() {};
                    node.trace = function() {};
                    node.send = function(msg) { node.lastSent = msg; };
                    node.status = function(status) { node.lastStatus = status; };
                    node.on = function() {};
                    return node;
                },
                getNode: function(id) {
                    return id === (workspaceNode && workspaceNode.id) ? workspaceNode : null;
                },
                registerType: function(type, constructor) {
                    constructors[type] = constructor;
                }
            },
            _: function(key, opts) {
                return (opts && opts.defaultValue) || key;
            },
            log: { info: function() {}, warn: function() {}, error: function() {} }
        };
    }

    // A workspace config node as it looks while its async setup is still
    // running: not valid yet, no project dir yet
    function makeInitializingWorkspaceNode() {
        return {
            id: 'ws-1',
            name: 'My Env',
            environment: 'default',
            workerStatus: 'initializing',
            startupTimeout: 5000,
            projectDir: null,
            isValid: function() { return false; }
        };
    }

    function makeConfig(overrides) {
        return Object.assign({
            id: 'run-node-1',
            name: 'Run',
            workspace: 'ws-1',
            command: 'mycmd',
            args: '--flag',
            timeout: 1000
        }, overrides);
    }

    beforeEach(function() {
        workspaceNode = makeInitializingWorkspaceNode();
        runNodeModule(createMockRED());
    });

    afterEach(function() {
        if (workspaceNode && workspaceNode.projectDir) {
            fs.rmSync(workspaceNode.projectDir, { recursive: true, force: true });
        }
    });

    it('should not error at construction while the workspace is still initializing, and become ready once it is valid', async function() {
        this.timeout(5000);
        const node = new constructors['python-run'](makeConfig());

        // no spurious "Invalid Python workspace configuration" on restart
        expect(node.errorCount || 0).to.equal(0);
        expect(node.nodeStatus).to.equal('initializing');

        // the workspace finishes its async setup
        workspaceNode.projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-ws-'));
        workspaceNode.workerStatus = 'valid';
        workspaceNode.isValid = function() { return true; };

        // waitForWorkspace polls every 500ms
        await new Promise(function(resolve) { setTimeout(resolve, 800); });

        expect(node.nodeStatus).to.equal('ready');
        expect(node.errorCount || 0).to.equal(0);
        expect(node.lastStatus).to.deep.equal({ fill: 'green', shape: 'dot', text: 'Ready' });
    });

    it('should surface an error if the workspace fails to initialize', async function() {
        this.timeout(5000);
        workspaceNode.workerStatus = 'error';

        const node = new constructors['python-run'](makeConfig());

        await new Promise(function(resolve) { setTimeout(resolve, 100); });
        expect(node.nodeStatus).to.equal('error');
        expect(node.lastError).to.contain('Invalid Python workspace configuration');
    });

    it('should stop polling when the node is closed mid-startup', async function() {
        this.timeout(5000);
        const node = new constructors['python-run'](makeConfig());
        expect(node.workspacePollTimer).to.not.be.null;

        await new Promise(function(resolve) { node.cleanup(resolve); });
        expect(node.workspacePollTimer).to.be.null;
    });

    it('should still error at construction when the workspace node does not exist at all', function() {
        workspaceNode = null;
        runNodeModule(createMockRED());
        const node = new constructors['python-run'](makeConfig());
        expect(node.nodeStatus).to.equal('error');
        expect(node.lastError).to.contain('Invalid Python workspace configuration');
    });

    it('should error at construction when the command is missing', function() {
        const node = new constructors['python-run'](makeConfig({ command: '' }));
        expect(node.nodeStatus).to.equal('error');
        expect(node.lastError).to.contain('Command is required');
    });
});
