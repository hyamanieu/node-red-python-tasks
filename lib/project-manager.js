// lib/project-manager.js - Manage persistent pixi workspaces for python-workspace nodes

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Workspaces being created or updated right now, keyed by workspace directory,
// so that concurrent deploys of the same environment run one pixi command
// sequence instead of racing each other
const inflightUpdates = new Map();

/**
 * Manages persistent pixi workspaces for python-workspace nodes
 *
 * The pixi root directory (NODE_RED_PYTHON_ENV_DIR, or ~/.node-red-python/workspaces)
 * contains one folder per workspace, and each workspace corresponds to one
 * user-facing environment: one python-workspace configuration node. Workspaces are
 * named after the environment's stable node id, so an environment keeps its
 * workspace across Node-RED restarts and redeploys. When the user modifies an
 * environment's dependencies, `pixi add` is run again on the same workspace so
 * the installed environment converges to the new dependency list. Workspace
 * folders are created and laid out by pixi itself: `pixi init` creates the
 * workspace, `pixi add` records the dependencies and resolves the environment.
 */
class ProjectManager {
    /**
     * Get the pixi root directory that holds all managed workspaces
     * @returns {string}
     */
    static getPixiRootDir() {
        return process.env.NODE_RED_PYTHON_ENV_DIR || path.join(os.homedir(), '.node-red-python', 'workspaces');
    }

    /**
     * Get the pixi executable path
     * @returns {string}
     */
    static getPixiPath() {
        // Check if PIXI_HOME is set (it should be in the container)
        if (process.env.PIXI_HOME) {
            return path.join(process.env.PIXI_HOME, 'bin', 'pixi');
        }
        // Fall back to just 'pixi' and let the system PATH resolve it
        return 'pixi';
    }

    /**
     * Run a pixi command and wait for it to finish
     * @param {string[]} args - command arguments (e.g., ['init', 'my-workspace'])
     * @param {string} cwd - working directory to run the command in
     * @returns {Promise<void>} - rejects with pixi's output on failure
     */
    static runPixi(args, cwd) {
        const timeoutMs = parseInt(process.env.NODE_RED_PIXI_COMMAND_TIMEOUT, 10) || 600000;

        return new Promise((resolve, reject) => {
            const child = spawn(this.getPixiPath(), args, {
                cwd,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stderr = '';
            const timer = setTimeout(function() {
                child.kill('SIGKILL');
                reject(new Error(`pixi ${args.join(' ')} timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            child.stdout.on('data', function(data) {
                console.log(`[pixi ${args[0]}] ${data.toString().trim()}`);
            });
            child.stderr.on('data', function(data) {
                stderr += data.toString();
            });
            child.on('error', function(err) {
                clearTimeout(timer);
                reject(new Error(`Failed to run pixi ${args[0]}: ${err.message}`));
            });
            child.on('close', function(code) {
                clearTimeout(timer);
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`pixi ${args.join(' ')} exited with code ${code}: ${stderr.trim()}`));
                }
            });
        });
    }

    /**
     * Normalize a dependency list: drop blanks, trim, sort
     * @param {string[]} dependencies - Array of dependency specs
     * @returns {string[]}
     */
    static normalizeDependencies(dependencies = []) {
        return dependencies
            .filter(dep => dep && dep.trim().length > 0)
            .map(dep => dep.trim())
            .sort();
    }

    /**
     * Get the deterministic workspace name for an environment
     *
     * The name derives from the environment's stable node id, so the same
     * environment always maps to the same workspace folder, whatever its
     * current dependency list. Without an id, the name falls back to a hash
     * of the dependency list.
     *
     * @param {string} environmentId - Stable identifier of the environment
     * @param {string[]} [dependencies] - Dependency specs, used only as fallback
     * @returns {string}
     */
    static getWorkspaceName(environmentId, dependencies = []) {
        const sanitized = (environmentId || '').replace(/[^a-zA-Z0-9._-]/g, '-');
        if (sanitized.length > 0) {
            return `node-red-python-workspace-${sanitized}`;
        }
        const key = this.normalizeDependencies(dependencies).join('\n');
        const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
        return `node-red-python-workspace-${hash}`;
    }

    /**
     * Check whether a workspace directory has a pixi manifest
     * @param {string} projectDir - Path to the workspace directory
     * @returns {boolean}
     */
    static hasManifest(projectDir) {
        return fs.existsSync(path.join(projectDir, 'pixi.toml')) ||
               fs.existsSync(path.join(projectDir, 'pyproject.toml'));
    }

    /**
     * Create or update the pixi workspace of an environment
     *
     * The workspace is one folder inside the pixi root directory, named after
     * the environment. A new workspace is created by `pixi init`. The
     * dependencies are then added with `pixi add` from inside the workspace,
     * which also resolves and installs the environment. `pixi add` runs on
     * every deploy, so a dependency the user added to the environment is
     * installed into the existing workspace; pixi treats dependencies that
     * are already present as a no-op.
     *
     * @param {string} environmentId - Stable identifier of the environment
     * @param {string[]} dependencies - Array of dependency specs (e.g., ["python=3.9", "numpy"])
     * @returns {Promise<string>} - Path to the workspace directory
     */
    static async createProject(environmentId, dependencies = []) {
        const rootDir = this.getPixiRootDir();
        const projectDir = path.join(rootDir, this.getWorkspaceName(environmentId, dependencies));
        console.log(`Creating/updating workspace for environment ${environmentId} at ${projectDir} with dependencies: ${dependencies.join(', ')}`);
        // Reuse an in-flight create/update of the same workspace, if one is running
        if (inflightUpdates.has(projectDir)) {
            return inflightUpdates.get(projectDir);
        }
        console.log(`No in-flight update for ${projectDir}, starting a new one`);
        const update = this.syncWorkspace(rootDir, projectDir, dependencies)
            .finally(function() {
                inflightUpdates.delete(projectDir);
            });
        console.log(`Adding ${projectDir} to in-flight updates`);
        inflightUpdates.set(projectDir, update);
        console.log(`Returning update promise for ${projectDir}`);
        return update;
    }

    /**
     * Bring a workspace in line with its dependency list
     * @param {string} rootDir - Path to the pixi root directory
     * @param {string} projectDir - Path to the workspace directory
     * @param {string[]} dependencies - Array of dependency specs
     * @returns {Promise<string>} - Path to the workspace directory
     */
    static async syncWorkspace(rootDir, projectDir, dependencies) {
        const workspaceExisted = this.hasManifest(projectDir);
        const deps = this.normalizeDependencies(dependencies);

        if (!workspaceExisted) {
            // Ensure the root exists; pixi manages everything inside it
            await fs.promises.mkdir(rootDir, { recursive: true });

            // Create the workspace; pixi owns the folder structure from here on
            await this.runPixi(['init', path.basename(projectDir)], rootDir);
        }

        // Add the dependencies from inside the workspace. On an existing
        // workspace this installs dependencies the user has added; pixi makes
        // it a no-op for dependencies that are already recorded.
        if (deps.length > 0) {
            try {
                await this.runPixi(['add'].concat(deps), projectDir);
            } catch (err) {
                if (!workspaceExisted) {
                    // Don't leave a half-built workspace behind on failure
                    await this.cleanupProject(projectDir);
                }
                // An existing workspace keeps its last working state
                throw err;
            }
        }

        return projectDir;
    }

    /**
     * Remove a workspace directory
     *
     * Only removes folders this manager owns: one workspace folder directly
     * inside the pixi root directory. Anything else is refused. Workspaces are
     * persistent, so this is an explicit operation, not part of the redeploy
     * lifecycle.
     *
     * @param {string} projectDir - Path to the workspace directory
     * @returns {Promise<void>}
     */
    static async cleanupProject(projectDir) {
        if (!projectDir) {
            return;
        }

        const rootDir = path.resolve(this.getPixiRootDir());
        const workspaceDir = path.resolve(projectDir);

        if (workspaceDir === rootDir || path.dirname(workspaceDir) !== rootDir) {
            console.warn(`[project-manager] Refusing to cleanup ${projectDir}: not a workspace inside the pixi root ${rootDir}`);
            return;
        }

        try {
            // Remove the workspace directory and all its contents
            await fs.promises.rm(workspaceDir, { recursive: true, force: true });
        } catch (err) {
            console.warn(`[project-manager] Failed to cleanup ${projectDir}: ${err.message}`);
        }
    }
}

module.exports = ProjectManager;
