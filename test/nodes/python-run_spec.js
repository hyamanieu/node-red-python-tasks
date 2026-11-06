// Test suite for nodes/python-run.js

const chai = require('chai');
const expect = chai.expect;
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

const runNodeModule = require('../../nodes/python-run');

// Fake ChildProcess: an event emitter with stdout/stderr emitters and a kill spy
function makeFakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { writable: true, write: function() {} };
    child.killed = false;
    child.kill = function() { child.killed = true; };
    return child;
}

describe('python-run node', function() {
    let constructors;
    let workspaceNode;
    let spawnCalls;
    let lastChild;
    let originalSpawn;

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

    function makeWorkspaceNode() {
        return {
            id: 'ws-1',
            name: 'My Env',
            environment: 'default',
            projectDir: fs.mkdtempSync(path.join(os.tmpdir(), 'run-ws-')),
            isValid: function() { return true; }
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
        workspaceNode = makeWorkspaceNode();
        spawnCalls = [];
        lastChild = null;
        originalSpawn = childProcess.spawn;
        childProcess.spawn = function(cmd, args, opts) {
            spawnCalls.push({ cmd, args, opts });
            lastChild = makeFakeChild();
            return lastChild;
        };
        runNodeModule(createMockRED());
    });

    afterEach(function() {
        childProcess.spawn = originalSpawn;
        if (workspaceNode) {
            fs.rmSync(workspaceNode.projectDir, { recursive: true, force: true });
        }
    });

    it('should error on input when the workspace does not exist', function() {
        workspaceNode = null;
        runNodeModule(createMockRED());
        const node = new constructors['python-run'](makeConfig());
        expect(node.nodeStatus).to.equal('error');

        const msg = { payload: 'x' };
        node.handleInput(msg);
        expect(node.errorCount).to.equal(2); // constructor + input
        expect(node.lastErrorMsg).to.equal(msg);
        expect(spawnCalls).to.have.lengthOf(0);
    });

    it('should run the command with fixed args plus stringified payload and send stdout as payload', function() {
        const node = new constructors['python-run'](makeConfig());
        const msg = { payload: 'hello', topic: 't1' };
        node.handleInput(msg);

        expect(spawnCalls).to.have.lengthOf(1);
        expect(spawnCalls[0].args).to.deep.equal(['run', '-e', 'default', '-x', 'mycmd', '--flag', 'hello']);
        expect(spawnCalls[0].opts.cwd).to.equal(workspaceNode.projectDir);

        lastChild.stdout.emit('data', Buffer.from('result text\n'));
        lastChild.emit('close', 0);

        expect(node.lastSent).to.deep.equal({ payload: 'result text', topic: 't1' });
        expect(node.nodeStatus).to.equal('ready');
        expect(node.activeProcesses.size).to.equal(0);
    });

    it('should pass an array payload as positional arguments and an object as one JSON argument', function() {
        const node = new constructors['python-run'](makeConfig({ args: '' }));
        node.handleInput({ payload: [1, 'two'] });
        expect(spawnCalls[0].args.slice(5)).to.deep.equal(['1', 'two']);

        node.handleInput({ payload: { a: 1 } });
        expect(spawnCalls[1].args.slice(5)).to.deep.equal([JSON.stringify({ a: 1 })]);
    });

    it('should report a non-zero exit code via node.error with the msg', function() {
        const node = new constructors['python-run'](makeConfig());
        const msg = { payload: 'x' };
        node.handleInput(msg);

        lastChild.stderr.emit('data', Buffer.from('boom'));
        lastChild.emit('close', 2);

        expect(node.lastError).to.contain('exit code 2');
        expect(node.lastErrorMsg).to.equal(msg);
        expect(node.lastSent).to.equal(undefined);
        expect(node.nodeStatus).to.equal('error');
    });

    it('should kill a running command on close instead of orphaning the process', async function() {
        const node = new constructors['python-run'](makeConfig());
        node.handleInput({ payload: 'x' });
        expect(node.activeProcesses.size).to.equal(1);

        await new Promise(function(resolve) { node.cleanup(resolve); });

        expect(lastChild.killed).to.be.true;
        expect(node.activeProcesses.size).to.equal(0);
    });
});
