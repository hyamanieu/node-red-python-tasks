// Test suite for lib/worker.js

const WorkerManager = require('../../lib/worker');
const chai = require('chai');
const expect = chai.expect;
const path = require('path');
const fs = require('fs');

describe('WorkerManager', function() {
    const testProjectDir = path.join(__dirname, '..', 'fixtures', 'pixi-project');

    before(function() {
        // Ensure test fixtures directory exists
        if (!fs.existsSync(testProjectDir)) {
            fs.mkdirSync(testProjectDir, { recursive: true });
        }
        
        // Create a minimal pixi.toml if it doesn't exist
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
    });

    describe('constructor', function() {
        it('should create a worker manager with options', function() {
            const manager = new WorkerManager({
                projectDir: testProjectDir,
                environment: 'test',
                startupTimeout: 5000
            });

            expect(manager.options.projectDir).to.equal(testProjectDir);
            expect(manager.options.environment).to.equal('test');
            expect(manager.options.startupTimeout).to.equal(5000);
            expect(manager.status).to.equal('stopped');
        });

        it('should use default values', function() {
            const manager = new WorkerManager({
                projectDir: testProjectDir
            });

            expect(manager.options.environment).to.equal('default');
            expect(manager.options.startupTimeout).to.equal(120000);
        });
    });

    describe('buildWorkerArgs', function() {
        it('should put the python -m after the executable, not pixi flags before it', function() {
            const manager = new WorkerManager({ projectDir: testProjectDir, environment: 'default' });

            // pixi run -e <env> python -m nrpyrun_worker:
            // '-m' before the command would be pixi's --manifest-path and fail
            // with "unable to canonicalize 'python'"
            expect(manager.buildWorkerArgs()).to.deep.equal(
                ['run', '-e', 'default', 'python', '-m', 'nrpyrun_worker']
            );
        });

        it('should use the configured environment and python path', function() {
            const manager = new WorkerManager({ projectDir: testProjectDir, environment: 'gpu', pythonPath: 'python3' });

            expect(manager.buildWorkerArgs()).to.deep.equal(
                ['run', '-e', 'gpu', 'python3', '-m', 'nrpyrun_worker']
            );
        });
    });

    describe('status management', function() {
        it('should start with stopped status', function() {
            const manager = new WorkerManager({ projectDir: testProjectDir });
            expect(manager.getStatus()).to.equal('stopped');
        });

        it('should report isReady correctly', function() {
            const manager = new WorkerManager({ projectDir: testProjectDir });
            expect(manager.isReady()).to.be.false;
        });
    });

    describe('createRequest and formatMessage', function() {
        it('should create properly formatted request messages', function() {
            const manager = new WorkerManager({ projectDir: testProjectDir });
            
            const message = manager.protocol.createRequest('define', {
                function_id: 'test_func',
                source: 'return payload * 2',
                imports: ['numpy']
            });

            const parsed = JSON.parse(message.trim());
            expect(parsed).to.have.property('id');
            expect(parsed).to.have.property('op', 'define');
            expect(parsed).to.have.property('function_id', 'test_func');
        });

        it('should format messages with newline', function() {
            const manager = new WorkerManager({ projectDir: testProjectDir });
            const formatted = manager.protocol.formatMessage({ id: '123', op: 'ping' });
            expect(formatted).to.match(/\n$/);
        });
    });

    describe('listeners', function() {
        it('should add and notify listeners', function(done) {
            const manager = new WorkerManager({ projectDir: testProjectDir });
            
            manager.addListener((event, ...args) => {
                expect(event).to.equal('test-event');
                expect(args).to.deep.equal(['arg1', 'arg2']);
                done();
            });

            manager.notifyListeners('test-event', 'arg1', 'arg2');
        });

        it('should handle listener errors without crashing', function() {
            const manager = new WorkerManager({ projectDir: testProjectDir });
            
            manager.addListener(() => {
                throw new Error('Listener error');
            });

            // Should not throw
            manager.notifyListeners('test-event');
        });
    });

    describe('stop during startup (deleted config node)', function() {
        // Regression: deleting a python-workspace config node runs close() ->
        // stop() while start() is still awaiting the pixi install check. The
        // in-flight start() must not spawn afterwards, and the resulting
        // spawn ENOENT (the workspace folder is already deleted) must not
        // schedule a restart loop.
        const missingDir = path.join(__dirname, '..', 'fixtures', 'does-not-exist');

        it('should not spawn or schedule restarts when stop() is called while start() is in flight', async function() {
            const manager = new WorkerManager({ projectDir: missingDir, startupTimeout: 5000 });

            const startPromise = manager.start();
            await manager.stop();
            await startPromise;

            // give any stray error/backoff events time to fire
            await new Promise(resolve => setTimeout(resolve, 300));

            expect(manager.status).to.equal('stopped');
            expect(manager.workerProcess).to.be.null;
            expect(manager.backoffTimer).to.be.null;
            expect(manager.restartCount).to.equal(0);
        });

        it('should ignore process error/exit events that arrive after stop()', async function() {
            const manager = new WorkerManager({ projectDir: missingDir, startupTimeout: 5000 });
            manager.status = 'starting';
            await manager.stop();

            manager.handleProcessError(new Error('spawn ENOENT'));
            manager.handleProcessExit(null);

            await new Promise(resolve => setTimeout(resolve, 300));

            expect(manager.status).to.equal('stopped');
            expect(manager.backoffTimer).to.be.null;
            expect(manager.restartCount).to.equal(0);
        });

        it('should not fire a pending backoff restart after stop()', async function() {
            const manager = new WorkerManager({ projectDir: missingDir, startupTimeout: 5000 });
            manager.status = 'error';
            manager.scheduleRestart();
            expect(manager.backoffTimer).to.not.be.null;

            await manager.stop();
            await new Promise(resolve => setTimeout(resolve, 300)); // backoff was 200ms

            expect(manager.backoffTimer).to.be.null;
            expect(manager.restartCount).to.equal(1); // no second restart was scheduled
            expect(manager.status).to.equal('stopped');
        });
    });

    describe('processIncoming', function() {
        it('should process ready messages', function(done) {
            const manager = new WorkerManager({ projectDir: testProjectDir });
            
            // listeners are called as listener(event, ...args)
            manager.once('ready', (event, message) => {
                expect(event).to.equal('ready');
                expect(message).to.deep.equal({
                    op: 'ready',
                    protocol: 1,
                    python: '3.12.3'
                });
                done();
            });

            manager.protocol.processIncoming('{"op":"ready","protocol":1,"python":"3.12.3"}\n');
        });

        it('should process error responses', function(done) {
            const manager = new WorkerManager({ projectDir: testProjectDir });
            
            // Create a request first
            const message = manager.protocol.createRequest('call', {
                function_id: 'test_func',
                payload: { test: 'data' }
            });
            const request = JSON.parse(message.trim());
            const requestId = request.id;

            manager.protocol.waitForResponse(requestId, 100).catch((err) => {
                expect(err).to.be.instanceOf(Error);
                expect(err.message).to.equal('test error');
                done();
            });

            // Process error response
            const errorResponse = `{"id":"${requestId}","ok":false,"error":{"type":"ValueError","message":"test error","traceback":"..."}}\n`;
            manager.protocol.processIncoming(errorResponse);
        });

        it('should process success responses', function(done) {
            const manager = new WorkerManager({ projectDir: testProjectDir });
            
            // Create a request first
            const message = manager.protocol.createRequest('call', {
                function_id: 'test_func',
                payload: { test: 'data' }
            });
            const request = JSON.parse(message.trim());
            const requestId = request.id;

            manager.protocol.waitForResponse(requestId, 100).then((response) => {
                expect(response.ok).to.be.true;
                expect(response.result).to.deep.equal({ output: 'result' });
                done();
            }).catch(done);

            // Process success response
            const successResponse = `{"id":"${requestId}","ok":true,"result":{"output":"result"}}\n`;
            manager.protocol.processIncoming(successResponse);
        });
    });
});
