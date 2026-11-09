// Throughput test (MVP acceptance criteria 3 and 4): loads the importable
// example examples/throughput.json into a real Node-RED runtime with
// node-red-node-test-helper and verifies that the 1000 messages the example
// generates are all processed through its python-function node at >= 200
// msg/s, on a single worker.
//
// ProjectManager and WorkerManager are stubbed for the same reason as in
// runtime_spec.js: a real start() spawns pixi and its restart-backoff timers
// would keep the mocha process alive after the results print. The stubbed
// callFunction emulates the example's `return toolz.frequencies(payload)` in
// JS so the example's wiring is exercised unchanged.

const path = require('path');
const os = require('os');
const fs = require('fs');

const chai = require('chai');
const expect = chai.expect;

const helper = require('node-red-node-test-helper');
helper.init(require.resolve('node-red'));

const ProjectManager = require('../../lib/project-manager');
const WorkerManager = require('../../lib/worker');
const workspaceNode = require('../../nodes/python-workspace');
const functionNode = require('../../nodes/python-function');
const runNode = require('../../nodes/python-run');
const injectNode = require('@node-red/nodes/core/common/20-inject.js');
const coreFunctionNode = require('@node-red/nodes/core/function/10-function.js');
const debugNode = require('@node-red/nodes/core/common/21-debug.js');

// The example flow as shipped; `global-config` is editor metadata, not a
// runtime node type, so it is stripped for the test runtime.
const exampleFlow = require('../../examples/throughput.json')
    .filter(n => n.type !== 'global-config');

describe('examples/throughput.json in a real Node-RED runtime (node-red-node-test-helper)', function() {
    this.timeout(20000);

    let originals;
    let startCalls;
    let defineCalls;

    async function waitFor(condition, timeoutMs) {
        const deadline = Date.now() + (timeoutMs || 8000);
        while (!condition()) {
            if (Date.now() > deadline) {
                throw new Error('timed out waiting for condition');
            }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }

    beforeEach(function(done) {
        // Isolate the workspace root so module-load reconciliation finds no
        // workspaces and never touches a real flows file
        process.env.NODE_RED_PYTHON_ENV_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nrp-thr-'));

        helper.startServer(done);

        originals = {
            createProject: ProjectManager.createProject,
            saveWorkspaceMeta: ProjectManager.saveWorkspaceMeta,
            cleanupProject: ProjectManager.cleanupProject,
            start: WorkerManager.prototype.start,
            stop: WorkerManager.prototype.stop,
            defineFunction: WorkerManager.prototype.defineFunction,
            callFunction: WorkerManager.prototype.callFunction
        };

        startCalls = 0;
        defineCalls = 0;

        ProjectManager.createProject = async function() { return path.join(os.tmpdir(), 'nrp-fake-ws'); };
        ProjectManager.saveWorkspaceMeta = async function() {};
        ProjectManager.cleanupProject = async function() {};
        WorkerManager.prototype.start = async function() {
            startCalls++;
            this.status = 'ready';
            this.notifyListeners('ready', { op: 'ready', protocol: 1, python: '3.13.0' });
        };
        WorkerManager.prototype.stop = async function() {
            this.status = 'stopped';
            this.notifyListeners('stopped');
        };
        WorkerManager.prototype.defineFunction = async function() {
            defineCalls++;
            return { ok: true };
        };
        // Emulate the example's `return toolz.frequencies(payload)`
        WorkerManager.prototype.callFunction = async function(functionId, payload) {
            const freq = {};
            if (Array.isArray(payload)) {
                for (const item of payload) {
                    freq[item] = (freq[item] || 0) + 1;
                }
            }
            return freq;
        };
    });

    afterEach(function(done) {
        ProjectManager.createProject = originals.createProject;
        ProjectManager.saveWorkspaceMeta = originals.saveWorkspaceMeta;
        ProjectManager.cleanupProject = originals.cleanupProject;
        WorkerManager.prototype.start = originals.start;
        WorkerManager.prototype.stop = originals.stop;
        WorkerManager.prototype.defineFunction = originals.defineFunction;
        WorkerManager.prototype.callFunction = originals.callFunction;
        helper.unload().then(function() { helper.stopServer(done); });
    });

    it('processes the example\'s 1000 messages through python-function at >= 200 msg/s on one worker', async function() {
        await helper.load([workspaceNode, functionNode, runNode, injectNode, coreFunctionNode, debugNode], exampleFlow);

        const ws = helper.getNode('862d3654b058f00f');
        const py = helper.getNode('8bafa94af61dd648');
        await waitFor(() => ws && ws.workerStatus === 'ready');
        await waitFor(() => py && py.isFunctionDefined === true);

        const rcv = helper.getNode('rcv1');
        const dbg = helper.getNode('dbg1');
        let received = 0;
        let sample = null;
        rcv.on('input', msg => { received++; if (!sample) { sample = msg; } });
        const stats = new Promise((resolve, reject) => {
            dbg.on('input', msg => { try { resolve(msg); } catch (e) { reject(e); } });
            setTimeout(() => reject(new Error('stats message not received within 10s')), 10000);
        });

        const t0 = Date.now();
        helper.getNode('inj1').receive({ payload: 'go' });
        const msg = await stats;
        const elapsed = Date.now() - t0;
        const rate = Math.round(1000 / (elapsed / 1000));

        console.log('    throughput: 1000 msgs in ' + elapsed + ' ms = ' + rate +
            ' msg/s (example reported ' + msg.payload.msgPerSec + ' msg/s over ' + msg.payload.elapsedMs + ' ms)');

        // All 1000 generated messages went through and the collector finished
        expect(received).to.equal(1000);
        expect(msg.payload.received).to.equal(1000);
        expect(msg.payload.expected).to.equal(1000);
        expect(msg.payload.timedOut).to.equal(false);

        // MVP acceptance criterion 4: at least 200 messages/second
        expect(rate).to.be.at.least(200);

        // MVP acceptance criterion 3: 1000 calls, exactly one worker started,
        // function defined once
        expect(startCalls).to.equal(1);
        expect(defineCalls).to.equal(1);

        // The example's Python function really ran on each payload: the output
        // is a word-frequency map of a 4..10-word array
        expect(sample.payload).to.be.an('object');
        const words = Object.values(sample.payload).reduce((a, b) => a + b, 0);
        expect(words).to.be.within(4, 10);
    });
});
