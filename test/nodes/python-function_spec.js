// Test suite for nodes/python-function.js

const chai = require('chai');
const expect = chai.expect;

const functionNodeModule = require('../../nodes/python-function');

describe('python-function node', function() {
    let constructors;
    let workspaceNode;
    let RED;

    function createMockRED() {
        constructors = {};
        return {
            nodes: {
                createNode: function(node, config) {
                    node.id = config.id || 'func-node-1';
                    node.log = function() {};
                    node.warn = function() {};
                    node.error = function(err, msg) {
                        node.lastError = err && err.message ? err.message : String(err);
                        node.lastErrorMsg = msg;
                        node.errorCount = (node.errorCount || 0) + 1;
                    };
                    node.debug = function() {};
                    node.trace = function() {};
                    node.send = function(msg) {
                        node.lastSent = msg;
                    };
                    node.status = function(status) {
                        node.lastStatus = status;
                    };
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
            log: {
                info: function() {},
                warn: function() {},
                error: function() {}
            }
        };
    }

    // Minimal fake of a worker manager
    function makeWorkerManager() {
        const listeners = [];
        return {
            ready: false,
            defined: [],
            isReady: function() { return this.ready; },
            addListener: function(l) { listeners.push(l); },
            removeListener: function(l) {
                const i = listeners.indexOf(l);
                if (i !== -1) { listeners.splice(i, 1); }
            },
            notify: function(event, ...args) {
                for (const l of listeners.slice()) { l(event, ...args); }
            },
            defineFunction: async function(functionId, source, imports, timeout) {
                this.defined.push({ functionId, source, imports, timeout });
            }
        };
    }

    // Minimal fake of the python-workspace config node
    function makeWorkspaceNode() {
        const manager = makeWorkerManager();
        return {
            id: 'ws-1',
            name: 'My Env',
            workerStatus: 'initializing',
            startupTimeout: 5000,
            manager: manager,
            isValid: function() {
                return ['valid', 'ready', 'starting'].indexOf(this.workerStatus) !== -1;
            },
            getWorkerManager: function() { return this.manager; }
        };
    }

    beforeEach(function() {
        workspaceNode = makeWorkspaceNode();
        RED = createMockRED();
        functionNodeModule(RED);
    });

    function makeConfig() {
        return {
            id: 'func-node-1',
            name: 'Double',
            workspace: 'ws-1',
            functionBody: 'return payload * 2',
            imports: '',
            timeout: 30000
        };
    }

    async function waitFor(condition, timeoutMs) {
        const deadline = Date.now() + (timeoutMs || 8000);
        while (!condition()) {
            if (Date.now() > deadline) {
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        return true;
    }

    it('should error immediately when the workspace does not exist', function() {
        workspaceNode = null;
        RED = createMockRED();
        functionNodeModule(RED);
        const node = new constructors['python-function'](makeConfig());

        expect(node.nodeStatus).to.equal('error');
        expect(node.errorCount).to.equal(1);
    });

    it('should wait for a still-initializing workspace instead of erroring, then define the function', async function() {
        this.timeout(15000);
        // the workspace node exists but its worker manager is not created yet
        const manager = workspaceNode.manager;
        workspaceNode.manager = null;

        const node = new constructors['python-function'](makeConfig());

        // no immediate error while the workspace is initializing
        expect(node.nodeStatus).to.not.equal('error');
        expect(node.errorCount || 0).to.equal(0);

        // the workspace finishes initializing and its worker is ready
        workspaceNode.manager = manager;
        workspaceNode.workerStatus = 'ready';
        manager.ready = true;

        const defined = await waitFor(() => manager.defined.length > 0);
        expect(defined).to.be.true;
        expect(manager.defined[0].functionId).to.equal('func_func-node-1');
        expect(manager.defined[0].source).to.equal('return payload * 2');
        expect(node.isFunctionDefined).to.be.true;
        expect(node.nodeStatus).to.equal('ready');
    });

    it('should define on the ready event when the worker is not ready yet', async function() {
        this.timeout(15000);
        const manager = workspaceNode.manager;
        workspaceNode.manager = null;

        const node = new constructors['python-function'](makeConfig());

        // workspace starts, worker manager exists but worker not ready
        workspaceNode.manager = manager;
        workspaceNode.workerStatus = 'starting';

        const waiting = await waitFor(() => node.nodeStatus === 'waiting');
        expect(waiting).to.be.true;

        // worker becomes ready -> function gets defined
        workspaceNode.workerStatus = 'ready';
        manager.ready = true;
        manager.notify('ready', { op: 'ready', protocol: 1, python: '3.12.3' });

        const defined = await waitFor(() => manager.defined.length > 0);
        expect(defined).to.be.true;
        expect(node.isFunctionDefined).to.be.true;
    });

    it('should fail input messages with the define error instead of queueing when the import is missing', async function() {
        this.timeout(15000);
        const manager = workspaceNode.manager;
        workspaceNode.manager = null;

        // the worker accepts define calls but the import fails, like
        // "No module named 'urllib3'" in an environment without urllib3
        const importError = new Error("Failed to import urllib3: No module named 'urllib3'");
        manager.defineFunction = async function() {
            throw importError;
        };

        const node = new constructors['python-function'](makeConfig());

        workspaceNode.manager = manager;
        workspaceNode.workerStatus = 'ready';
        manager.ready = true;
        manager.notify('ready', { op: 'ready', protocol: 1, python: '3.13.18' });

        const failed = await waitFor(() => node.nodeStatus === 'error');
        expect(failed).to.be.true;
        expect(node.defineError).to.equal(importError);
        expect(node.isFunctionDefined).to.be.false;
        expect(node.lastStatus).to.deep.equal({ fill: 'red', shape: 'dot', text: 'Error' });
        // the define failure itself is logged with a readable message
        expect(node.lastError).to.contain('Failed to define function: ');
        expect(node.lastError).to.contain("No module named 'urllib3'");

        // an input message must reach node.error(err, msg) (catchable),
        // not be queued behind a yellow "messages queued" status
        const msg = { payload: 'hello' };
        const errorsBefore = node.errorCount;
        node.handleInput(msg);

        expect(node.errorCount).to.equal(errorsBefore + 1);
        expect(node.lastErrorMsg).to.equal(msg);
        expect(node.lastError).to.contain("No module named 'urllib3'");
        expect(node.pendingMessages).to.have.length(0);
        expect(node.nodeStatus).to.equal('error');
        expect(node.lastStatus).to.deep.equal({ fill: 'red', shape: 'dot', text: 'Error' });
    });

    it('should still queue messages while the worker is starting', async function() {
        this.timeout(15000);
        const manager = workspaceNode.manager;
        workspaceNode.manager = null;

        const node = new constructors['python-function'](makeConfig());

        workspaceNode.manager = manager;
        workspaceNode.workerStatus = 'starting';

        const waiting = await waitFor(() => node.nodeStatus === 'waiting');
        expect(waiting).to.be.true;

        const msg = { payload: 1 };
        node.handleInput(msg);

        expect(node.pendingMessages).to.have.length(1);
        expect(node.nodeStatus).to.equal('queued');
        expect(node.lastStatus).to.deep.equal({ fill: 'yellow', shape: 'dot', text: 'Messages queued' });
        expect(node.errorCount || 0).to.equal(0);
    });
});
