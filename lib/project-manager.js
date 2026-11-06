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

// Name of the metadata file stored inside each workspace folder. It records
// which python-workspace config node owns the workspace, so that on startup
// every workspace on disk can be represented exactly once as a config node
// even if the flow file was lost (e.g. the host container was recreated).
const WORKSPACE_META_FILE = '.node-red-workspace.json';

/**
 * Manages persistent pixi workspaces for python-workspace nodes
 *
 * The pixi root directory (NODE_RED_PYTHON_ENV_DIR, or ~/.node-red-python/workspaces)
 * contains one folder per workspace, and each workspace corresponds to one
 * user-facing environment: one python-workspace configuration node. A workspace
 * folder is named after the environment's user-given name, so it is recognizable
 * on the host and stable across Node-RED restarts and redeploys. When the user
 * modifies an environment's dependencies, `pixi add` is run again on the same
 * workspace so the installed environment converges to the new dependency list.
 * Workspace folders are created and laid out by pixi itself: `pixi init` creates
 * the workspace, `pixi add` records the dependencies and resolves the environment.
 *
 * The workspaces on disk are the source of truth for which environments exist:
 * `reconcileFlowsFile()` runs before Node-RED loads the flows and makes sure each
 * workspace folder is represented exactly once as a python-workspace config node
 * in the flow file.
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
     * Get the deterministic workspace folder name for an environment
     *
     * The folder is named after the name the user gave the environment, so the
     * same environment always maps to the same workspace folder, whatever its
     * current dependency list. Names that cannot be used as a folder name
     * (empty, or only unsafe characters such as '.' and '..') fall back to a
     * hash of the dependency list.
     *
     * @param {string} name - User-given name of the environment
     * @param {string[]} [dependencies] - Dependency specs, used only as fallback
     * @returns {string}
     */
    static getWorkspaceName(name, dependencies = []) {
        const sanitized = (name || '').replace(/[^a-zA-Z0-9._-]/g, '-');
        if (sanitized.length > 0 && sanitized !== '.' && sanitized !== '..' && !sanitized.startsWith('.')) {
            return sanitized;
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
     * Path of the metadata file inside a workspace directory
     * @param {string} projectDir - Path to the workspace directory
     * @returns {string}
     */
    static getWorkspaceMetaPath(projectDir) {
        return path.join(projectDir, WORKSPACE_META_FILE);
    }

    /**
     * Record which python-workspace config node owns a workspace, so the
     * workspace can be represented as a config node again after a restart
     * that lost the flow file
     * @param {string} projectDir - Path to the workspace directory
     * @param {object} meta - { id, name, dependencies, environment, startupTimeout }
     * @returns {Promise<object>} - the metadata that was written
     */
    static async saveWorkspaceMeta(projectDir, meta) {
        const data = Object.assign({}, meta, { updatedAt: new Date().toISOString() });
        await fs.promises.writeFile(this.getWorkspaceMetaPath(projectDir), JSON.stringify(data, null, 2) + '\n', 'utf8');
        return data;
    }

    /**
     * Read the metadata file of a workspace, if present and well-formed
     * @param {string} projectDir - Path to the workspace directory
     * @returns {object|null}
     */
    static readWorkspaceMeta(projectDir) {
        try {
            const meta = JSON.parse(fs.readFileSync(this.getWorkspaceMetaPath(projectDir), 'utf8'));
            return (meta && typeof meta === 'object') ? meta : null;
        } catch (err) {
            return null;
        }
    }

    /**
     * List all workspaces that exist on disk inside the pixi root directory
     *
     * Each workspace is one folder with a pixi manifest. The workspaces on
     * disk are the source of truth for which environments exist: whatever
     * happened to the host (e.g. a recreated container), every workspace
     * folder must still be represented as a config node.
     *
     * @returns {Array<{name: string, dir: string, meta: object|null}>} - sorted by folder name
     */
    static listWorkspaces() {
        const rootDir = this.getPixiRootDir();
        let entries;
        try {
            entries = fs.readdirSync(rootDir, { withFileTypes: true });
        } catch (err) {
            // No pixi root yet: no workspaces
            return [];
        }
        const workspaces = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) {
                continue;
            }
            const dir = path.join(rootDir, entry.name);
            if (!this.hasManifest(dir)) {
                continue;
            }
            workspaces.push({ name: entry.name, dir, meta: this.readWorkspaceMeta(dir) });
        }
        workspaces.sort(function(a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
        return workspaces;
    }

    /**
     * Best-effort recovery of the dependency list of a workspace from its
     * pixi manifest, used for workspaces that predate the metadata file
     * @param {string} projectDir - Path to the workspace directory
     * @returns {string[]} - dependency specs found in the [dependencies] table
     */
    static parseDependenciesFromManifest(projectDir) {
        const tomlPath = path.join(projectDir, 'pixi.toml');
        if (!fs.existsSync(tomlPath)) {
            return [];
        }
        let text;
        try {
            text = fs.readFileSync(tomlPath, 'utf8');
        } catch (err) {
            return [];
        }
        const deps = [];
        let section = '';
        for (const rawLine of text.split('\n')) {
            const line = rawLine.trim();
            if (line.length === 0 || line.startsWith('#')) {
                continue;
            }
            const header = /^\[\[?([^\]]+)\]?\]$/.exec(line);
            if (header) {
                section = header[1].trim();
                continue;
            }
            if (section !== 'dependencies') {
                continue;
            }
            const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
            if (!kv) {
                continue;
            }
            const key = kv[1];
            const value = kv[2].trim();
            // join as `key=spec`, unless the spec already starts with a match
            // operator (`numpy = ">=2.0"` means `numpy>=2.0`)
            const join = function(spec) {
                if (spec.length === 0) {
                    return key;
                }
                return /^[<>=!~]/.test(spec) ? `${key}${spec}` : `${key}=${spec}`;
            };
            const quoted = /^"([^"]*)"|^'([^']*)'/.exec(value);
            if (quoted) {
                deps.push(join(quoted[1] !== undefined ? quoted[1] : quoted[2]));
            } else if (value.startsWith('{')) {
                // inline table, e.g. numpy = { version = ">=2", channel = "..." }
                const vm = /version\s*=\s*"([^"]*)"/.exec(value);
                deps.push(vm && vm[1] ? join(vm[1]) : key);
            } else {
                deps.push(join(value));
            }
        }
        return deps;
    }

    /**
     * Parse a node's dependencies field (newline-separated string or array)
     * @param {string|string[]} dependencies
     * @returns {string[]}
     */
    static parseDependencyList(dependencies) {
        if (Array.isArray(dependencies)) {
            return dependencies.filter(dep => dep && String(dep).trim().length > 0).map(dep => String(dep).trim());
        }
        if (typeof dependencies === 'string') {
            return dependencies.split('\n').map(dep => dep.trim()).filter(dep => dep.length > 0);
        }
        return [];
    }

    /**
     * Check whether a python-workspace flow entry represents a workspace folder
     * @param {object} node - flow entry of type python-workspace
     * @param {{name: string, meta: object|null}} workspace - entry from listWorkspaces()
     * @returns {boolean}
     */
    static nodeRepresentsWorkspace(node, workspace) {
        if (workspace.meta && workspace.meta.id && node.id === workspace.meta.id) {
            return true;
        }
        const folderName = this.getWorkspaceName(node.name || '', this.parseDependencyList(node.dependencies));
        if (folderName === workspace.name) {
            return true;
        }
        // Folders created by older versions were named node-red-python-workspace-<node id>
        return workspace.name === `node-red-python-workspace-${node.id}`;
    }

    /**
     * Make sure every workspace on disk is represented exactly once as a
     * python-workspace config node in a flow configuration
     *
     * Pure function: given the flows array and the workspaces from
     * listWorkspaces(), return a new flows array in which each workspace has
     * exactly one config node. Existing nodes are kept (matched by metadata id,
     * by the folder name derived from the node's name, or by the legacy
     * node-id-based folder name); missing ones are appended; duplicates are
     * dropped, keeping the metadata-id match or the first one.
     *
     * @param {object[]} flows - the flow configuration (array of node entries)
     * @param {Array<{name: string, dir: string, meta: object|null}>} workspaces
     * @returns {object[]} - the reconciled flow configuration
     */
    static reconcileFlows(flows, workspaces) {
        if (!Array.isArray(flows) || !Array.isArray(workspaces)) {
            return flows;
        }
        const usedIds = new Set(flows.map(n => n && n.id).filter(Boolean));
        const representedBy = new Map(); // workspace name -> kept node id
        const dropIds = new Set();
        for (const workspace of workspaces) {
            const matches = flows.filter(n => n && n.type === 'python-workspace' && this.nodeRepresentsWorkspace(n, workspace));
            if (matches.length === 0) {
                continue;
            }
            const best = matches.find(n => workspace.meta && workspace.meta.id && n.id === workspace.meta.id) || matches[0];
            representedBy.set(workspace.name, best.id);
            for (const m of matches) {
                if (m.id !== best.id) {
                    dropIds.add(m.id);
                }
            }
        }
        const result = flows.filter(n => !(n && dropIds.has(n.id)));
        for (const workspace of workspaces) {
            if (representedBy.has(workspace.name)) {
                continue;
            }
            const meta = workspace.meta || {};
            const id = (meta.id && !usedIds.has(meta.id)) ? meta.id : crypto.randomBytes(8).toString('hex');
            usedIds.add(id);
            let deps = Array.isArray(meta.dependencies) ? meta.dependencies.slice() : [];
            if (deps.length === 0) {
                // Workspace predates the metadata file: recover the dependency
                // list from the pixi manifest as best as possible
                deps = this.parseDependenciesFromManifest(workspace.dir);
            }
            result.push({
                id,
                type: 'python-workspace',
                name: meta.name || workspace.name,
                dependencies: deps.join('\n'),
                environment: meta.environment || 'default',
                startupTimeout: meta.startupTimeout || 120000
            });
        }
        return result;
    }

    /**
     * Resolve the path of the Node-RED flows file, mimicking Node-RED's own
     * resolution (settings.flowFile relative to the user dir, or the
     * flows_<hostname>.json default)
     * @param {object} settings - RED.settings
     * @returns {string}
     */
    static getFlowsFilePath(settings = {}) {
        const userDir = settings.userDir || path.join(os.homedir(), '.node-red');
        let flowFile = settings.flowFile;
        if (flowFile === true) {
            flowFile = 'flows.json';
        }
        if (!flowFile || typeof flowFile !== 'string') {
            flowFile = 'flows_' + os.hostname() + '.json';
        }
        if (path.isAbsolute(flowFile)) {
            return flowFile;
        }
        if (flowFile.startsWith('./')) {
            return path.join(process.cwd(), flowFile);
        }
        if (fs.existsSync(path.join(process.cwd(), flowFile))) {
            return path.join(process.cwd(), flowFile);
        }
        return path.join(userDir, flowFile);
    }

    /**
     * Reconcile the on-disk workspaces with the flows file on disk
     *
     * Runs before Node-RED loads the flows (node modules are loaded first), so
     * workspaces survive whatever happened to the host: if the flow file lost
     * the python-workspace config nodes, they are added back here, exactly one
     * per workspace folder. Never throws; returns what happened.
     *
     * @param {object} settings - RED.settings (uses userDir and flowFile)
     * @returns {{added: number, removed: number}} - number of config nodes added/removed
     */
    static reconcileFlowsFile(settings = {}) {
        const empty = { added: 0, removed: 0 };
        if (settings.readOnly) {
            return empty;
        }
        let flowsPath;
        try {
            flowsPath = this.getFlowsFilePath(settings);
        } catch (err) {
            return empty;
        }
        let raw = null;
        try {
            raw = fs.readFileSync(flowsPath, 'utf8');
        } catch (err) {
            if (err.code !== 'ENOENT') {
                return empty;
            }
            // no flows file at all: recreate it from the workspaces on disk
        }
        let flows;
        if (raw === null) {
            flows = [];
        } else {
            try {
                flows = JSON.parse(raw);
            } catch (err) {
                return empty; // malformed flows file: leave it to Node-RED to report
            }
            if (!Array.isArray(flows)) {
                return empty;
            }
        }
        const workspaces = this.listWorkspaces();
        if (workspaces.length === 0) {
            return empty;
        }
        const reconciled = this.reconcileFlows(flows, workspaces);
        if (JSON.stringify(reconciled) === JSON.stringify(flows)) {
            return empty; // already exactly-once represented
        }
        fs.writeFileSync(flowsPath, JSON.stringify(reconciled, null, 4) + '\n', 'utf8');
        return { added: Math.max(0, reconciled.length - flows.length), removed: Math.max(0, flows.length - reconciled.length) };
    }

    /**
     * Create or update the pixi workspace of an environment
     *
     * The workspace is one folder inside the pixi root directory, named after
     * the environment's user-given name. A new workspace is created by
     * `pixi init`. The dependencies are then added with `pixi add` from inside
     * the workspace, which also resolves and installs the environment.
     * `pixi add` runs on every deploy, so a dependency the user added to the
     * environment is installed into the existing workspace; pixi treats
     * dependencies that are already present as a no-op.
     *
     * @param {string} name - User-given name of the environment; the workspace folder is named after it
     * @param {string[]} dependencies - Array of dependency specs (e.g., ["python=3.9", "numpy"])
     * @returns {Promise<string>} - Path to the workspace directory
     */
    static async createProject(name, dependencies = []) {
        const rootDir = this.getPixiRootDir();
        const projectDir = path.join(rootDir, this.getWorkspaceName(name, dependencies));
        console.log(`Creating/updating workspace for environment "${name}" at ${projectDir} with dependencies: ${dependencies.join(', ')}`);
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
