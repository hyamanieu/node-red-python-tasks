// Test suite for lib/project-manager.js

const ProjectManager = require('../../lib/project-manager');
const chai = require('chai');
const expect = chai.expect;
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

// Integration tests drive the real pixi CLI; skip them when it is unavailable
let pixiAvailable = false;
try {
    execFileSync(ProjectManager.getPixiPath(), ['--version'], { stdio: 'ignore' });
    pixiAvailable = true;
} catch (err) {
    pixiAvailable = false;
}

describe('ProjectManager', function() {
    let rootDir;
    let savedEnvDir;

    beforeEach(function() {
        // Give each test its own pixi root so workspaces are isolated
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-manager-test-'));
        savedEnvDir = process.env.NODE_RED_PYTHON_ENV_DIR;
        process.env.NODE_RED_PYTHON_ENV_DIR = rootDir;
    });

    afterEach(function() {
        if (savedEnvDir === undefined) {
            delete process.env.NODE_RED_PYTHON_ENV_DIR;
        } else {
            process.env.NODE_RED_PYTHON_ENV_DIR = savedEnvDir;
        }
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    describe('pixi root directory', function() {
        it('should use NODE_RED_PYTHON_ENV_DIR when set', function() {
            expect(ProjectManager.getPixiRootDir()).to.equal(rootDir);
        });

        it('should default to a persistent folder in the home dir when unset', function() {
            delete process.env.NODE_RED_PYTHON_ENV_DIR;
            expect(ProjectManager.getPixiRootDir())
                .to.equal(path.join(os.homedir(), '.node-red-python', 'workspaces'));
        });
    });

    describe('workspace naming', function() {
        it('should name a workspace folder after the name given by the user', function() {
            expect(ProjectManager.getWorkspaceName('env-1', ['numpy']))
                .to.equal('env-1');
        });

        it('should map the same environment to the same workspace name', function() {
            expect(ProjectManager.getWorkspaceName('env-1', ['numpy']))
                .to.equal(ProjectManager.getWorkspaceName('env-1', ['numpy', 'pandas']));
        });

        it('should map different environments to different workspace names', function() {
            expect(ProjectManager.getWorkspaceName('env-1'))
                .to.not.equal(ProjectManager.getWorkspaceName('env-2'));
        });

        it('should sanitize characters that are unsafe in a folder name', function() {
            expect(ProjectManager.getWorkspaceName('a/b c'))
                .to.equal('a-b-c');
        });

        it('should fall back to a dependency hash without a usable name', function() {
            expect(ProjectManager.getWorkspaceName('', ['numpy']))
                .to.match(/^node-red-python-workspace-[0-9a-f]{16}$/);
        });

        it('should fall back to a dependency hash for names that are unsafe as folder names', function() {
            expect(ProjectManager.getWorkspaceName('..', ['numpy']))
                .to.match(/^node-red-python-workspace-[0-9a-f]{16}$/);
            expect(ProjectManager.getWorkspaceName('.', ['numpy']))
                .to.match(/^node-red-python-workspace-[0-9a-f]{16}$/);
            expect(ProjectManager.getWorkspaceName('.hidden', ['numpy']))
                .to.match(/^node-red-python-workspace-[0-9a-f]{16}$/);
        });
    });

    describe('createProject reuse', function() {
        it('should reuse an existing workspace without invoking pixi when no dependencies are given', async function() {
            const workspaceDir = path.join(rootDir, ProjectManager.getWorkspaceName('env-1'));
            fs.mkdirSync(workspaceDir);
            fs.writeFileSync(path.join(workspaceDir, 'pixi.toml'), '[project]\n');

            // pixi is never invoked here, so this passes without pixi installed
            const projectDir = await ProjectManager.createProject('env-1', []);

            expect(projectDir).to.equal(workspaceDir);
            expect(fs.readFileSync(path.join(workspaceDir, 'pixi.toml'), 'utf8'))
                .to.equal('[project]\n');
        });
    });

    describe('workspace metadata', function() {
        it('should round-trip workspace metadata inside the workspace folder', async function() {
            const workspaceDir = path.join(rootDir, 'my-env');
            fs.mkdirSync(workspaceDir, { recursive: true });

            await ProjectManager.saveWorkspaceMeta(workspaceDir, {
                id: 'abc123',
                name: 'my-env',
                dependencies: ['numpy'],
                environment: 'default',
                startupTimeout: 120000
            });

            const meta = ProjectManager.readWorkspaceMeta(workspaceDir);
            expect(meta.id).to.equal('abc123');
            expect(meta.name).to.equal('my-env');
            expect(meta.dependencies).to.deep.equal(['numpy']);
            expect(meta.environment).to.equal('default');
            expect(meta.updatedAt).to.be.a('string');
        });

        it('should return null for a missing or malformed metadata file', function() {
            const workspaceDir = path.join(rootDir, 'no-meta');
            fs.mkdirSync(workspaceDir, { recursive: true });
            expect(ProjectManager.readWorkspaceMeta(workspaceDir)).to.be.null;

            fs.writeFileSync(ProjectManager.getWorkspaceMetaPath(workspaceDir), 'not json{');
            expect(ProjectManager.readWorkspaceMeta(workspaceDir)).to.be.null;
        });
    });

    describe('listWorkspaces', function() {
        it('should list every workspace folder with a manifest, sorted by name', function() {
            const wsA = path.join(rootDir, 'ws-a');
            const wsB = path.join(rootDir, 'ws-b');
            fs.mkdirSync(wsA, { recursive: true });
            fs.writeFileSync(path.join(wsA, 'pixi.toml'), '[project]\n');
            fs.mkdirSync(wsB, { recursive: true });
            fs.writeFileSync(path.join(wsB, 'pyproject.toml'), '[project]\n');
            // not a workspace: no manifest, a plain file, a hidden folder
            fs.mkdirSync(path.join(rootDir, 'not-a-workspace'), { recursive: true });
            fs.writeFileSync(path.join(rootDir, 'a-file.txt'), 'x');
            fs.mkdirSync(path.join(rootDir, '.hidden'), { recursive: true });
            fs.writeFileSync(path.join(rootDir, '.hidden', 'pixi.toml'), '[project]\n');

            const workspaces = ProjectManager.listWorkspaces();

            expect(workspaces.map(w => w.name)).to.deep.equal(['ws-a', 'ws-b']);
            expect(workspaces[0].dir).to.equal(wsA);
            expect(workspaces[0].meta).to.be.null;
        });

        it('should read the metadata of each listed workspace', function() {
            const ws = path.join(rootDir, 'ws-meta');
            fs.mkdirSync(ws, { recursive: true });
            fs.writeFileSync(path.join(ws, 'pixi.toml'), '[project]\n');
            fs.writeFileSync(ProjectManager.getWorkspaceMetaPath(ws),
                JSON.stringify({ id: 'node-1', name: 'ws-meta', dependencies: ['numpy'] }));

            const workspaces = ProjectManager.listWorkspaces();
            expect(workspaces).to.have.lengthOf(1);
            expect(workspaces[0].meta.id).to.equal('node-1');
        });

        it('should return an empty list when the pixi root does not exist', function() {
            expect(ProjectManager.listWorkspaces()).to.deep.equal([]);
        });
    });

    describe('parseDependenciesFromManifest', function() {
        it('should recover dependency specs from the pixi manifest', function() {
            const ws = path.join(rootDir, 'ws-deps');
            fs.mkdirSync(ws, { recursive: true });
            fs.writeFileSync(path.join(ws, 'pixi.toml'), [
                '[project]',
                'name = "ws-deps"',
                '',
                '[dependencies]',
                'python = "3.12.*"',
                'numpy = ">=2.0,<3"',
                'pandas = { version = ">=2.0", channel = "conda-forge" }',
                '',
                '[feature.cuda.dependencies]',
                'ignored = "1.0"',
                ''
            ].join('\n'));

            expect(ProjectManager.parseDependenciesFromManifest(ws))
                .to.deep.equal(['python=3.12.*', 'numpy>=2.0,<3', 'pandas>=2.0']);
        });

        it('should return an empty list without a pixi.toml', function() {
            const ws = path.join(rootDir, 'ws-nodeps');
            fs.mkdirSync(ws, { recursive: true });
            expect(ProjectManager.parseDependenciesFromManifest(ws)).to.deep.equal([]);
        });
    });

    describe('reconcileFlows', function() {
        function makeWorkspace(name, meta, manifest) {
            const dir = path.join(rootDir, name);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'pixi.toml'), manifest || '[project]\n');
            if (meta) {
                fs.writeFileSync(ProjectManager.getWorkspaceMetaPath(dir), JSON.stringify(meta));
            }
            return { name, dir, meta: meta || null };
        }

        it('should add exactly one config node for a workspace missing from the flows', function() {
            const ws = makeWorkspace('my-env', { id: 'node-1', name: 'my-env', dependencies: ['python=3.12', 'numpy'], environment: 'default' });
            const flows = [{ id: 'tab-1', type: 'tab', label: 'Flow 1' }];

            const result = ProjectManager.reconcileFlows(flows, [ws]);

            expect(result).to.have.lengthOf(2);
            const added = result.find(n => n.type === 'python-workspace');
            expect(added.id).to.equal('node-1');
            expect(added.name).to.equal('my-env');
            expect(added.dependencies).to.equal('python=3.12\nnumpy');
            expect(added.environment).to.equal('default');
            expect(added).to.not.have.property('z');
            // the original flows array is untouched
            expect(flows).to.have.lengthOf(1);
        });

        it('should not add a second config node when the workspace is already represented', function() {
            const ws = makeWorkspace('my-env', { id: 'node-1', name: 'my-env', dependencies: ['numpy'] });
            const flows = [
                { id: 'tab-1', type: 'tab' },
                { id: 'node-1', type: 'python-workspace', name: 'my-env', dependencies: 'numpy' }
            ];

            const result = ProjectManager.reconcileFlows(flows, [ws]);

            expect(result.filter(n => n.type === 'python-workspace')).to.have.lengthOf(1);
        });

        it('should match an existing node by the folder name derived from its name', function() {
            const ws = makeWorkspace('py312', null);
            const flows = [
                { id: 'some-other-id', type: 'python-workspace', name: 'py312', dependencies: 'python=3.12' }
            ];

            const result = ProjectManager.reconcileFlows(flows, [ws]);

            expect(result).to.have.lengthOf(1);
            expect(result[0].id).to.equal('some-other-id');
        });

        it('should match a legacy node-red-python-workspace-<id> folder by node id', function() {
            const ws = makeWorkspace('node-red-python-workspace-legacy1', null);
            const flows = [
                { id: 'legacy1', type: 'python-workspace', name: 'old name', dependencies: 'numpy' }
            ];

            const result = ProjectManager.reconcileFlows(flows, [ws]);

            expect(result).to.have.lengthOf(1);
        });

        it('should keep exactly one node when duplicates map to the same workspace', function() {
            const ws = makeWorkspace('my-env', { id: 'node-1', name: 'my-env', dependencies: ['numpy'] });
            const flows = [
                { id: 'node-2', type: 'python-workspace', name: 'my-env', dependencies: 'numpy' },
                { id: 'node-1', type: 'python-workspace', name: 'my-env', dependencies: 'numpy' }
            ];

            const result = ProjectManager.reconcileFlows(flows, [ws]);
            const nodes = result.filter(n => n.type === 'python-workspace');

            expect(nodes).to.have.lengthOf(1);
            expect(nodes[0].id).to.equal('node-1');
        });

        it('should restore a legacy workspace without metadata using its folder name and manifest deps', function() {
            const ws = makeWorkspace('node-red-python-workspace-abcdef0123456789', null,
                '[project]\n\n[dependencies]\npython = "3.12.*"\nnumpy = ">=2.0"\n');
            const flows = [{ id: 'tab-1', type: 'tab' }];

            const result = ProjectManager.reconcileFlows(flows, [ws]);
            const added = result.find(n => n.type === 'python-workspace');

            expect(added.name).to.equal('node-red-python-workspace-abcdef0123456789');
            expect(added.dependencies).to.equal('python=3.12.*\nnumpy>=2.0');
            expect(added.id).to.match(/^[0-9a-f]{16}$/);
        });

        it('should return non-array input unchanged', function() {
            expect(ProjectManager.reconcileFlows(null, [])).to.be.null;
            expect(ProjectManager.reconcileFlows('nope', [])).to.equal('nope');
        });
    });

    describe('reconcileFlowsFile', function() {
        it('should add missing config nodes to the flows file on disk, exactly once', function() {
            const ws = path.join(rootDir, 'my-env');
            fs.mkdirSync(ws, { recursive: true });
            fs.writeFileSync(path.join(ws, 'pixi.toml'), '[project]\n');
            fs.writeFileSync(ProjectManager.getWorkspaceMetaPath(ws),
                JSON.stringify({ id: 'node-1', name: 'my-env', dependencies: ['numpy'] }));

            const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-userdir-'));
            const flowsPath = path.join(userDir, 'test-flows.json');
            fs.writeFileSync(flowsPath, JSON.stringify([{ id: 'tab-1', type: 'tab', label: 'Flow 1' }]));

            try {
                const first = ProjectManager.reconcileFlowsFile({ userDir, flowFile: 'test-flows.json' });
                expect(first.added).to.equal(1);

                const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
                expect(flows.filter(n => n.type === 'python-workspace')).to.have.lengthOf(1);
                expect(flows.find(n => n.type === 'python-workspace').id).to.equal('node-1');

                // running again must not duplicate the config node
                const second = ProjectManager.reconcileFlowsFile({ userDir, flowFile: 'test-flows.json' });
                expect(second.added).to.equal(0);
                const flowsAgain = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
                expect(flowsAgain.filter(n => n.type === 'python-workspace')).to.have.lengthOf(1);
            } finally {
                fs.rmSync(userDir, { recursive: true, force: true });
            }
        });

        it('should recreate a missing flows file from the workspaces on disk', function() {
            const ws = path.join(rootDir, 'my-env');
            fs.mkdirSync(ws, { recursive: true });
            fs.writeFileSync(path.join(ws, 'pixi.toml'), '[project]\n');
            fs.writeFileSync(ProjectManager.getWorkspaceMetaPath(ws),
                JSON.stringify({ id: 'node-1', name: 'my-env', dependencies: ['numpy'] }));

            const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-userdir-'));
            const flowsPath = path.join(userDir, 'test-flows.json');

            try {
                const result = ProjectManager.reconcileFlowsFile({ userDir, flowFile: 'test-flows.json' });
                expect(result.added).to.equal(1);
                expect(fs.existsSync(flowsPath)).to.be.true;
                const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
                const nodes = flows.filter(n => n.type === 'python-workspace');
                expect(nodes).to.have.lengthOf(1);
                expect(nodes[0].id).to.equal('node-1');
                expect(nodes[0].name).to.equal('my-env');
            } finally {
                fs.rmSync(userDir, { recursive: true, force: true });
            }
        });

        it('should not throw when the flows file is missing or malformed', function() {
            const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-userdir-'));
            try {
                // no flows file at all
                expect(ProjectManager.reconcileFlowsFile({ userDir, flowFile: 'test-flows.json' }).added).to.equal(0);
                // malformed flows file
                fs.writeFileSync(path.join(userDir, 'test-flows.json'), '{ not json');
                expect(ProjectManager.reconcileFlowsFile({ userDir, flowFile: 'test-flows.json' }).added).to.equal(0);
                // non-array flows file
                fs.writeFileSync(path.join(userDir, 'test-flows.json'), '{"a":1}');
                expect(ProjectManager.reconcileFlowsFile({ userDir, flowFile: 'test-flows.json' }).added).to.equal(0);
            } finally {
                fs.rmSync(userDir, { recursive: true, force: true });
            }
        });
    });

    describe('cleanupProject', function() {
        it('should remove a workspace folder inside the pixi root', async function() {
            const workspaceDir = path.join(rootDir, 'node-red-python-workspace-test');
            fs.mkdirSync(workspaceDir);
            fs.writeFileSync(path.join(workspaceDir, 'pixi.toml'), '');

            await ProjectManager.cleanupProject(workspaceDir);

            expect(fs.existsSync(workspaceDir)).to.be.false;
        });

        it('should refuse to remove a directory outside the pixi root', async function() {
            const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));

            await ProjectManager.cleanupProject(outsideDir);

            expect(fs.existsSync(outsideDir)).to.be.true;
            fs.rmSync(outsideDir, { recursive: true, force: true });
        });

        it('should refuse to remove the pixi root itself', async function() {
            await ProjectManager.cleanupProject(rootDir);

            expect(fs.existsSync(rootDir)).to.be.true;
        });
    });

    describe('pixi CLI integration', function() {
        beforeEach(function() {
            if (!pixiAvailable) {
                this.skip();
            }
        });

        it('should create a workspace via pixi init inside the pixi root', async function() {
            this.timeout(120000);

            const projectDir = await ProjectManager.createProject('env-init', []);

            expect(path.dirname(projectDir)).to.equal(rootDir);
            expect(fs.existsSync(projectDir)).to.be.true;
            // pixi owns the folder structure: the manifest comes from pixi init
            expect(ProjectManager.hasManifest(projectDir)).to.be.true;

            await ProjectManager.cleanupProject(projectDir);
            expect(fs.existsSync(projectDir)).to.be.false;
        });

        it('should add dependencies via pixi add', async function() {
            this.timeout(180000);

            // noarch packages with no glibc requirement, so they install in
            // any container (the dev container is Alpine/musl)
            const projectDir = await ProjectManager.createProject('env-add', ['ca-certificates']);

            const manifestPath = path.join(projectDir, 'pixi.toml');
            const manifest = fs.existsSync(manifestPath)
                ? fs.readFileSync(manifestPath, 'utf8')
                : fs.readFileSync(path.join(projectDir, 'pyproject.toml'), 'utf8');
            expect(manifest).to.contain('ca-certificates');
        });

        it('should use the same workspace for the same environment', async function() {
            this.timeout(180000);

            const first = await ProjectManager.createProject('env-same', ['ca-certificates']);
            const second = await ProjectManager.createProject('env-same', ['ca-certificates']);

            expect(second).to.equal(first);
            expect(ProjectManager.hasManifest(first)).to.be.true;
        });

        it('should install added dependencies into the existing workspace via pixi add', async function() {
            this.timeout(180000);

            const projectDir = await ProjectManager.createProject('env-modify', ['ca-certificates']);

            // The user adds a dependency to the environment and redeploys
            const modifiedDir = await ProjectManager.createProject('env-modify', ['ca-certificates', 'tzdata']);

            expect(modifiedDir).to.equal(projectDir);
            const manifestPath = path.join(projectDir, 'pixi.toml');
            const manifest = fs.existsSync(manifestPath)
                ? fs.readFileSync(manifestPath, 'utf8')
                : fs.readFileSync(path.join(projectDir, 'pyproject.toml'), 'utf8');
            expect(manifest).to.contain('ca-certificates');
            expect(manifest).to.contain('tzdata');
        });

        it('should use different workspaces for different environments', async function() {
            this.timeout(180000);

            const first = await ProjectManager.createProject('env-a', ['ca-certificates']);
            const second = await ProjectManager.createProject('env-b', ['ca-certificates']);

            expect(second).to.not.equal(first);
        });

        it('should keep the existing workspace when pixi add fails on it', async function() {
            this.timeout(180000);

            const projectDir = await ProjectManager.createProject('env-badadd', ['ca-certificates']);

            let rejected = null;
            try {
                await ProjectManager.createProject('env-badadd', ['ca-certificates', 'this-package-does-not-exist-xyz=1.0']);
            } catch (err) {
                rejected = err;
            }

            expect(rejected).to.not.be.null;
            expect(rejected.message).to.match(/pixi add/);
            // The previously working environment is untouched
            expect(fs.existsSync(projectDir)).to.be.true;
        });

        it('should not leave a half-built workspace behind when the first pixi add fails', async function() {
            this.timeout(120000);

            let rejected = null;
            try {
                await ProjectManager.createProject('env-freshfail', ['this-package-does-not-exist-xyz=1.0']);
            } catch (err) {
                rejected = err;
            }

            expect(rejected).to.not.be.null;
            expect(rejected.message).to.match(/pixi add/);
            expect(fs.readdirSync(rootDir)).to.have.lengthOf(0);
        });
    });
});
