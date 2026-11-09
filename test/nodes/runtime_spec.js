// Runtime-level tests with node-red-node-test-helper: the nodes are loaded into
// a real Node-RED runtime, so palette loading, wiring, catch-node error routing
// and close/unload behaviour are exercised end to end (MVP acceptance criteria
// 1, 5, 7 and 11). ProjectManager and WorkerManager are stubbed so no pixi
// process or worker is spawned — a real start() spawns pixi and its restart
// backoff timers would keep the mocha process alive after the results print.

const path = require('path');
const os = require('os');
const fs = require('fs');
const EventEmitter = require('events');

const chai = require('chai');
const expect = chai.expect;

const helper = require('node-red-node-test-helper');
helper.init(require.resolve('node-red'));

const childProcess = require('child_process');
const ProjectManager = require('../../lib/project-manager');
const WorkerManager = require('../../lib/worker');
const workspaceNode = require('../../nodes/python-workspace');
const functionNode = require('../../nodes/python-function');
const runNode = require('../../nodes/python-run');
const catchNode = require('@node-red/nodes/core/common/25-catch.js');

describe('nodes in a real Node-RED runtime (node-red-node-test-helper)', function() {
    this.timeout(20000);

    let originals;
    let callBehavior;
    let lastChild;

    function makeFlow() {
        return [
            { id: 'ws1', type: 'python-workspace', name: 'Test Env', dependencies: 'python=3.13', environment: 'default', startupTimeout: 5000 },
            { id: 'f1', type: 'python-function', name: 'double', workspace: 'ws1', functionBody: 'return payload * 2', imports: '', timeout: 5000, wires: [['h1']] },
            { id: 'r1', type: 'python-run', name: 'run', workspace: 'ws1', command: 'mycmd', args: '', timeout: 5000, wires: [['h3']] },
            { id: 'c1', type: 'catch', wires: [['h2']] },
            { id: 'h1', type: 'helper' },
            { id: 'h2', type: 'helper' },
            { id: 'h3', type: 'helper' }
        ];
    }

    async function waitFor(condition, timeoutMs) {
        const deadline = Date.now() + (timeoutMs || 8000);
        while (!condition()) {
            if (Date.now() > deadline) {
                throw new Error('timed out waiting for condition');
            }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }

    function fakeSpawn() {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 4242;
        child.kill = function() {};
        lastChild = child;
        return child;
    }

    beforeEach(function(done) {
        // Isolate the workspace root so module-load reconciliation finds no
        // workspaces and never touches the real flows file
        process.env.NODE_RED_PYTHON_ENV_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nrp-helper-'));

        helper.startServer(done);

        originals = {
            createProject: ProjectManager.createProject,
            saveWorkspaceMeta: ProjectManager.saveWorkspaceMeta,
            cleanupProject: ProjectManager.cleanupProject,
            start: WorkerManager.prototype.start,
            stop: WorkerManager.prototype.stop,
            defineFunction: WorkerManager.prototype.defineFunction,
            callFunction: WorkerManager.prototype.callFunction,
            spawn: childProcess.spawn
        };

        ProjectManager.createProject = async function() { return path.join(os.tmpdir(), 'nrp-fake-ws'); };
        ProjectManager.saveWorkspaceMeta = async function() {};
        ProjectManager.cleanupProject = async function() {};
        WorkerManager.prototype.start = async function() {
            this.status = 'ready';
            this.notifyListeners('ready', { op: 'ready', protocol: 1, python: '3.13.0' });
        };
        WorkerManager.prototype.stop = async function() {
            this.status = 'stopped';
            this.notifyListeners('stopped');
        };
        WorkerManager.prototype.defineFunction = async function() { return { ok: true }; };
        WorkerManager.prototype.callFunction = async function(functionId, payload) { return callBehavior(payload); };
        childProcess.spawn = fakeSpawn;
    });

    afterEach(function(done) {
        ProjectManager.createProject = originals.createProject;
        ProjectManager.saveWorkspaceMeta = originals.saveWorkspaceMeta;
        ProjectManager.cleanupProject = originals.cleanupProject;
        WorkerManager.prototype.start = originals.start;
        WorkerManager.prototype.stop = originals.stop;
        WorkerManager.prototype.defineFunction = originals.defineFunction;
        WorkerManager.prototype.callFunction = originals.callFunction;
        childProcess.spawn = originals.spawn;
        helper.unload().then(function() { helper.stopServer(done); });
    });

    it('loads all three node types and brings the workspace to ready', async function() {
        await helper.load([workspaceNode, functionNode, runNode, catchNode], makeFlow());
        expect(helper.getNode('ws1')).to.not.be.null;
        expect(helper.getNode('f1')).to.not.be.null;
        expect(helper.getNode('r1')).to.not.be.null;
        await waitFor(() => helper.getNode('ws1').workerStatus === 'ready');
        await waitFor(() => helper.getNode('f1').isFunctionDefined === true);
    });

    it('sends the function result to output 1 and preserves other msg properties', async function() {
        callBehavior = payload => payload * 2;
        await helper.load([workspaceNode, functionNode, runNode, catchNode], makeFlow());
        await waitFor(() => helper.getNode('f1').isFunctionDefined === true);

        const f1 = helper.getNode('f1');
        const h1 = helper.getNode('h1');
        const received = new Promise((resolve, reject) => {
            h1.on('input', msg => { try { resolve(msg); } catch (e) { reject(e); } });
            setTimeout(() => reject(new Error('no output within 8s')), 8000);
        });
        f1.receive({ payload: 21, topic: 'keep/me' });
        const msg = await received;
        expect(msg.payload).to.equal(42);
        expect(msg.topic).to.equal('keep/me');
    });

    it('routes a Python exception to a real catch node with type, message and traceback', async function() {
        callBehavior = () => {
            const err = new Error('division by zero');
            err.type = 'ZeroDivisionError';
            err.traceback = 'Traceback ... ZeroDivisionError: division by zero';
            throw err;
        };
        await helper.load([workspaceNode, functionNode, runNode, catchNode], makeFlow());
        await waitFor(() => helper.getNode('f1').isFunctionDefined === true);

        const f1 = helper.getNode('f1');
        const h1 = helper.getNode('h1');
        const h2 = helper.getNode('h2');
        let h1Got = false;
        h1.on('input', () => { h1Got = true; });
        const caught = new Promise((resolve, reject) => {
            h2.on('input', msg => { try { resolve(msg); } catch (e) { reject(e); } });
            setTimeout(() => reject(new Error('catch node did not fire within 8s')), 8000);
        });
        // call:error carries the raw error object passed to node.error(err, msg)
        const callError = new Promise(resolve => { f1.on('call:error', c => resolve(c.args[0])); });
        f1.receive({ payload: 1 });
        const msg = await caught;
        const err = await callError;
        expect(h1Got).to.equal(false);
        // The runtime forwards message/stack/source on msg.error (Node-RED's
        // handleError only copies those); type/traceback stay on the error object
        expect(msg.error).to.exist;
        expect(msg.error.message).to.match(/division by zero/);
        expect(msg.error.source.id).to.equal('f1');
        expect(err.type).to.equal('ZeroDivisionError');
        expect(err.traceback).to.match(/ZeroDivisionError/);
    });

    it('returns captured stdout from python-run on success', async function() {
        callBehavior = payload => payload;
        await helper.load([workspaceNode, functionNode, runNode, catchNode], makeFlow());
        await waitFor(() => helper.getNode('ws1').workerStatus === 'ready');

        const r1 = helper.getNode('r1');
        const h3 = helper.getNode('h3');
        const received = new Promise((resolve, reject) => {
            h3.on('input', msg => { try { resolve(msg); } catch (e) { reject(e); } });
            setTimeout(() => reject(new Error('no output within 8s')), 8000);
        });
        r1.receive({ payload: 'x' });
        // The stubbed spawn returns lastChild synchronously; emit the result
        setImmediate(() => {
            lastChild.stdout.emit('data', Buffer.from('hello world\n'));
            lastChild.emit('close', 0);
        });
        const msg = await received;
        expect(msg.payload).to.equal('hello world');
    });

    it('routes a non-zero python-run exit status to a real catch node with the exit code', async function() {
        callBehavior = payload => payload;
        await helper.load([workspaceNode, functionNode, runNode, catchNode], makeFlow());
        await waitFor(() => helper.getNode('ws1').workerStatus === 'ready');

        const r1 = helper.getNode('r1');
        const h3 = helper.getNode('h3');
        const h2 = helper.getNode('h2');
        let h3Got = false;
        h3.on('input', () => { h3Got = true; });
        const caught = new Promise((resolve, reject) => {
            h2.on('input', msg => { try { resolve(msg); } catch (e) { reject(e); } });
            setTimeout(() => reject(new Error('catch node did not fire within 8s')), 8000);
        });
        const callError = new Promise(resolve => { r1.on('call:error', c => resolve(c.args[0])); });
        r1.receive({ payload: 'x' });
        setImmediate(() => {
            lastChild.stderr.emit('data', Buffer.from('boom'));
            lastChild.emit('close', 2);
        });
        const msg = await caught;
        const err = await callError;
        expect(h3Got).to.equal(false);
        expect(msg.error.message).to.match(/exit code 2/);
        expect(err.exitCode).to.equal(2);
    });
});
