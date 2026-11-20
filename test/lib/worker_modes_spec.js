// Test suite for the Python worker's execution modes (threads/processes/sequential)
//
// Spawns the real worker with the system python3 (skipped when python3 is not
// available) and forces NRPYRUN_WORKER_MODE, then checks the ready message and
// where a "call" actually executes.

const chai = require('chai');
const expect = chai.expect;
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

let pythonAvailable = false;
try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    pythonAvailable = true;
} catch (err) {
    pythonAvailable = false;
}

const PYTHON_DIR = path.join(__dirname, '..', '..', 'python');

// Function body that reports where it runs
const INTROSPECTION_SOURCE = [
    'return {',
    '    "thread": threading.current_thread().name,',
    '    "is_main_thread": threading.current_thread() is threading.main_thread(),',
    '    "process": multiprocessing.current_process().name,',
    '    "in_pool_process": multiprocessing.parent_process() is not None',
    '}'
].join('\n');

describe('python worker execution modes', function() {
    if (!pythonAvailable) {
        it('skipped: python3 is not available on this host', function() {
            this.skip();
        });
        return;
    }

    this.timeout(60000);

    let workDir;
    let child;

    before(function() {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrpyrun-modes-'));
    });

    after(function() {
        fs.rmSync(workDir, { recursive: true, force: true });
    });

    afterEach(function() {
        if (child) {
            try {
                process.kill(-child.pid, 'SIGKILL'); // whole process group
            } catch (err) {
                child.kill('SIGKILL');
            }
            child = null;
        }
    });

    /**
     * Start a worker with the given NRPYRUN_WORKER_MODE, return a helper to
     * talk JSON-lines with it.
     */
    function startWorker(mode) {
        const env = Object.assign({}, process.env, {
            PYTHONPATH: PYTHON_DIR
        });
        if (mode) {
            env.NRPYRUN_WORKER_MODE = mode;
        } else {
            delete env.NRPYRUN_WORKER_MODE;
        }
        // detached: the worker gets its own process group so afterEach can
        // kill the pool processes too (a plain SIGKILL on the worker would
        // orphan them and keep the stdout pipe open, hanging mocha)
        child = spawn('python3', ['-m', 'nrpyrun_worker'], { cwd: workDir, env, detached: true });

        const lines = [];
        const waiters = [];
        let buffer = '';
        child.stdout.on('data', (data) => {
            buffer += data.toString();
            let idx;
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                if (!line.trim()) {
                    continue;
                }
                const msg = JSON.parse(line);
                lines.push(msg);
                for (let i = waiters.length - 1; i >= 0; i--) {
                    if (waiters[i].pred(msg)) {
                        waiters[i].resolve(msg);
                        waiters.splice(i, 1);
                    }
                }
            }
        });

        return {
            send(obj) {
                child.stdin.write(JSON.stringify(obj) + '\n');
            },
            waitFor(pred, timeoutMs) {
                const existing = lines.find(pred);
                if (existing) {
                    return Promise.resolve(existing);
                }
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('timed out waiting for worker message')), timeoutMs || 30000);
                    waiters.push({
                        pred,
                        resolve: (msg) => { clearTimeout(timer); resolve(msg); }
                    });
                });
            }
        };
    }

    async function defineAndCall(worker, id) {
        worker.send({ id: 'def-' + id, op: 'define', function_id: 'f-' + id, source: INTROSPECTION_SOURCE, imports: ['threading', 'multiprocessing'] });
        await worker.waitFor(m => m.id === 'def-' + id && m.ok === true);
        worker.send({ id: 'call-' + id, op: 'call', function_id: 'f-' + id, payload: {} });
        const resp = await worker.waitFor(m => m.id === 'call-' + id);
        expect(resp.ok, JSON.stringify(resp.error)).to.be.true;
        return resp.result;
    }

    it('reports the forced mode in the ready message and runs calls inline in sequential mode', async function() {
        const worker = startWorker('sequential');
        const ready = await worker.waitFor(m => m.op === 'ready');
        expect(ready.mode).to.equal('sequential');

        const result = await defineAndCall(worker, 'seq');
        // sequential: the call ran on the reader thread of the main process
        expect(result.is_main_thread).to.be.true;
        expect(result.thread).to.equal('MainThread');
        expect(result.process).to.equal('MainProcess');
        expect(result.in_pool_process).to.be.false;
    });

    it('runs calls on pool threads in threads mode', async function() {
        const worker = startWorker('threads');
        const ready = await worker.waitFor(m => m.op === 'ready');
        expect(ready.mode).to.equal('threads');

        const result = await defineAndCall(worker, 'thr');
        expect(result.thread).to.match(/^nrpyrun-call_\d+$/);
        expect(result.is_main_thread).to.be.false;
        expect(result.in_pool_process).to.be.false;
    });

    it('runs calls in pool processes in processes mode', async function() {
        const worker = startWorker('processes');
        const ready = await worker.waitFor(m => m.op === 'ready');
        expect(ready.mode).to.equal('processes');

        const result = await defineAndCall(worker, 'proc');
        expect(result.in_pool_process).to.be.true;
        expect(result.process).to.match(/^SpawnProcess-\d+$/);
    });

    it('fail-safe: submit_call runs inline in sequential mode even when called directly, bypassing dispatch', function() {
        // The worker in sequential mode has executor=None; dispatch() routes
        // calls away from submit_call, but submit_call must not crash if it
        // is reached anyway
        const fixture = path.join(__dirname, '..', 'fixtures', 'worker_submit_call_failsafe.py');
        const out = execFileSync('python3', [fixture], {
            env: Object.assign({}, process.env, { PYTHONPATH: PYTHON_DIR }),
            encoding: 'utf8',
            timeout: 30000
        });
        const messages = out.trim().split('\n').map(l => JSON.parse(l));
        const def = messages.find(m => m.id === 'd1');
        const call = messages.find(m => m.id === 'c1');
        expect(def && def.ok, out).to.be.true;
        expect(call && call.ok, out).to.be.true;
        expect(call.result.thread).to.equal('MainThread');
    });

    it('auto mode picks a pool mode from the interpreter (threads on no-GIL, processes on GIL)', async function() {
        const worker = startWorker(null); // no NRPYRUN_WORKER_MODE
        const ready = await worker.waitFor(m => m.op === 'ready');
        expect(['threads', 'processes']).to.include(ready.mode);
        // and it must agree with the free_threaded flag
        if (ready.free_threaded) {
            expect(ready.mode).to.equal('threads');
        } else {
            expect(ready.mode).to.equal('processes');
        }
    });
});
