// Test suite for nodes/python-workspace.js

const chai = require('chai');
const expect = chai.expect;
const path = require('path');
const fs = require('fs');
const os = require('os');

const ProjectManager = require('../../lib/project-manager');
const WorkerManager = require('../../lib/worker');
const workspaceNodeModule = require('../../nodes/python-workspace');

describe('python-workspace node', function() {
    let rootDir;
    let savedEnvDir;
    let constructors;
    let RED;

    // Stubs installed per-test so the node never spawns pixi in unit tests
    const originalCreateProject = ProjectManager.createProject;
    const originalStart = WorkerManager.prototype.start;

    function createMockRED(settings) {
        constructors = {};
        return {
            nodes: {
                createNode: function(node, config) {
                    node.id = config.id || 'test-node-' + Date.now();
                    node.log = function() {};
                    node.warn = function() {};
                    node.error = function(err) {
                        node.lastError = err && err.message ? err.message : String(err);
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
                getNode: function() {
                    return null;
                },
                registerType: function(type, constructor) {
                    constructors[type] = constructor;
                }
            },
            settings: settings || {},
            _: function(key) {
                return key;
            },
            log: {
                info: function() {},
                warn: function() {},
                error: function() {}
            }
        };
    }

    // Stub createProject so no pixi command runs; returns a workspace dir
    function stubCreateProject(calls) {
        ProjectManager.createProject = async function(name, deps) {
            calls.push({ name, deps });
            const dir = path.join(rootDir, ProjectManager.getWorkspaceName(name, deps));
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'pixi.toml'), '[project]\n');
            return dir;
        };
    }

    function stubWorkerStart() {
        WorkerManager.prototype.start = async function() {
            this.status = 'ready';
            this.notifyListeners('ready');
        };
    }

    async function settle(node) {
        // let the node's async validateConfig -> createWorkerManager -> start chain finish
        for (let i = 0; i < 200; i++) {
            await new Promise(resolve => setTimeout(resolve, 5));
            if (node.workerStatus === 'ready' || node.workerStatus === 'error' || node.workerStatus === 'stopped') {
                return;
            }
        }
    }

    beforeEach(function() {
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-node-test-'));
        savedEnvDir = process.env.NODE_RED_PYTHON_ENV_DIR;
        process.env.NODE_RED_PYTHON_ENV_DIR = rootDir;
    });

    afterEach(function() {
        ProjectManager.createProject = originalCreateProject;
        WorkerManager.prototype.start = originalStart;
        if (savedEnvDir === undefined) {
            delete process.env.NODE_RED_PYTHON_ENV_DIR;
        } else {
            process.env.NODE_RED_PYTHON_ENV_DIR = savedEnvDir;
        }
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    describe('workspace creation', function() {
        it('should name the workspace folder after the user-given name and record metadata', async function() {
            const calls = [];
            stubCreateProject(calls);
            stubWorkerStart();

            RED = createMockRED({});
            workspaceNodeModule(RED);
            const node = new constructors['python-workspace']({
                id: 'node-abc',
                name: 'My Env',
                dependencies: 'python=3.12\nnumpy',
                environment: 'default',
                startupTimeout: 120000
            });
            await settle(node);

            expect(calls).to.have.lengthOf(1);
            expect(calls[0].name).to.equal('My Env');
            expect(calls[0].deps).to.deep.equal(['python=3.12', 'numpy']);
            expect(node.projectDir).to.equal(path.join(rootDir, 'My-Env'));
            expect(node.isValid()).to.be.true;

            const meta = ProjectManager.readWorkspaceMeta(node.projectDir);
            expect(meta.id).to.equal('node-abc');
            expect(meta.name).to.equal('My Env');
            expect(meta.dependencies).to.deep.equal(['python=3.12', 'numpy']);
            expect(meta.environment).to.equal('default');
        });

        it('should reject empty dependencies without creating a workspace', async function() {
            const calls = [];
            stubCreateProject(calls);
            stubWorkerStart();

            RED = createMockRED({});
            workspaceNodeModule(RED);
            const node = new constructors['python-workspace']({
                id: 'node-empty',
                name: 'Empty',
                dependencies: '  \n ',
                environment: 'default'
            });
            await settle(node);

            expect(calls).to.have.lengthOf(0);
            expect(node.isValid()).to.be.false;
            expect(node.workerStatus).to.equal('error');
        });
    });

    describe('startup reconciliation', function() {
        it('should represent each on-disk workspace exactly once as a config node in the flow file', function() {
            // A workspace that exists on disk (created before a host restart),
            // with its metadata file, but missing from the flow file
            const wsDir = path.join(rootDir, 'restored-env');
            fs.mkdirSync(wsDir, { recursive: true });
            fs.writeFileSync(path.join(wsDir, 'pixi.toml'), '[project]\n');
            fs.writeFileSync(ProjectManager.getWorkspaceMetaPath(wsDir), JSON.stringify({
                id: 'node-old',
                name: 'restored-env',
                dependencies: ['numpy']
            }));

            const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-userdir-'));
            const flowsPath = path.join(userDir, 'test-flows.json');
            fs.writeFileSync(flowsPath, JSON.stringify([{ id: 'tab-1', type: 'tab', label: 'Flow 1' }]));

            try {
                RED = createMockRED({ userDir, flowFile: 'test-flows.json' });
                // loading the node module is what triggers the reconciliation
                workspaceNodeModule(RED);

                let flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
                let nodes = flows.filter(n => n.type === 'python-workspace');
                expect(nodes).to.have.lengthOf(1);
                expect(nodes[0].id).to.equal('node-old');
                expect(nodes[0].name).to.equal('restored-env');
                expect(nodes[0].dependencies).to.equal('numpy');

                // loading again must not duplicate the config node
                workspaceNodeModule(RED);
                flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
                nodes = flows.filter(n => n.type === 'python-workspace');
                expect(nodes).to.have.lengthOf(1);
            } finally {
                fs.rmSync(userDir, { recursive: true, force: true });
            }
        });

        it('should leave the flow file alone when every workspace is already represented', function() {
            const wsDir = path.join(rootDir, 'my-env');
            fs.mkdirSync(wsDir, { recursive: true });
            fs.writeFileSync(path.join(wsDir, 'pixi.toml'), '[project]\n');
            fs.writeFileSync(ProjectManager.getWorkspaceMetaPath(wsDir), JSON.stringify({
                id: 'node-1',
                name: 'my-env',
                dependencies: ['numpy']
            }));

            const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-userdir-'));
            const flowsPath = path.join(userDir, 'test-flows.json');
            const original = [
                { id: 'tab-1', type: 'tab', label: 'Flow 1' },
                { id: 'node-1', type: 'python-workspace', name: 'my-env', dependencies: 'numpy' }
            ];
            fs.writeFileSync(flowsPath, JSON.stringify(original));

            try {
                RED = createMockRED({ userDir, flowFile: 'test-flows.json' });
                workspaceNodeModule(RED);

                const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
                expect(flows).to.deep.equal(original);
            } finally {
                fs.rmSync(userDir, { recursive: true, force: true });
            }
        });
    });

    describe('cleanup', function() {
        it('should call done callback on cleanup', async function() {
            stubCreateProject([]);
            stubWorkerStart();

            RED = createMockRED({});
            workspaceNodeModule(RED);
            const node = new constructors['python-workspace']({
                id: 'node-cleanup',
                name: 'Cleanup Env',
                dependencies: 'numpy',
                environment: 'default'
            });
            await settle(node);

            await new Promise(function(resolve) {
                node.cleanup(resolve);
            });
            expect(node.workerStatus).to.equal('stopped');
        });
    });
});
