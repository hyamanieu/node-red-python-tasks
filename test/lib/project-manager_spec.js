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
        it('should name a workspace after its environment id', function() {
            expect(ProjectManager.getWorkspaceName('env-1', ['numpy']))
                .to.equal('node-red-python-workspace-env-1');
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
                .to.equal('node-red-python-workspace-a-b-c');
        });

        it('should fall back to a dependency hash without an environment id', function() {
            expect(ProjectManager.getWorkspaceName('', ['numpy']))
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
