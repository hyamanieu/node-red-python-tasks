// python-workspace node - configuration node for Python workspaces
// Manages pixi-based Python workspaces and persistent worker processes

const path = require('path');
const fs = require('fs');
const WorkerManager = require('../lib/worker');
const ProjectManager = require('../lib/project-manager');

module.exports = function(RED) {
    // Node modules are loaded before Node-RED reads the flows, so this is the
    // place to make the on-disk workspaces count: every workspace folder under
    // the Python environments directory is represented exactly once as a
    // config node in the flow file, even if the host (e.g. a container) was
    // recreated and the flow file lost them. Never let this break startup.
    try {
        const reconciled = ProjectManager.reconcileFlowsFile(RED.settings || {});
        if (reconciled.added > 0) {
            console.log(`[python-workspace] Restored ${reconciled.added} Python workspace configuration node(s) from existing environments on disk`);
        }
    } catch (err) {
        console.warn(`[python-workspace] Could not reconcile environments with the flow file: ${err.message}`);
    }

    /**
     * Python Workspace Configuration Node
     * Defines a Python workspace by listing dependencies, internally manages a pixi project
     */
    function PythonWorkspaceNode(config) {
        RED.nodes.createNode(this, config);

        // Store configuration
        this.name = config.name || '';
        this.dependencies = config.dependencies || '';
        this.environment = config.environment || 'default';
        this.startupTimeout = parseInt(config.startupTimeout) || 120000;
        
        // Internal: the generated project directory
        this.projectDir = null;

        // Worker manager instance
        this.workerManager = null;
        
        // Node status tracking
        this.workerStatus = 'initializing';

        // Validate configuration and create project directory (async)
        const node = this;
        this.validateConfig().then(function(isValid) {
            if (isValid) {
                node.createWorkerManager();
            }
        }).catch(function(err) {
            node.error('Configuration validation failed: ' + err.message);
            node.workerStatus = 'error';
            node.updateStatus();
        });

        // Handle node close (redeploy or removal)
        this.on('close', function(done) {
            node.cleanup(done);
        });
    }

    /**
     * Validate the configuration and create the project directory
     * @returns {Promise<boolean>} - true if valid
     */
    PythonWorkspaceNode.prototype.validateConfig = async function() {
        // Check if dependencies are provided
        this.warn(`Validating workspace configuration for environment ${this.environment} with dependencies: ${this.dependencies}`);
        if (!this.dependencies || this.dependencies.trim().length === 0) {
            this.error(RED._('python-workspace.errors.noDependencies') || 'At least one dependency is required');
            this.workerStatus = 'error';
            return false;
        }

        // Parse dependencies from newline-separated string
        const deps = this.parseDependencies();
        
        if (deps.length === 0) {
            this.error(RED._('python-workspace.errors.invalidDependencies') || 'Invalid dependency specifications');
            this.workerStatus = 'error';
            return false;
        }

    this.warn(`Creating project dir for environment ${this.environment} with dependencies: ${this.dependencies} (${deps.join(', ')})`);
        try {
            // Create or update the environment's workspace. The workspace
            // folder is named after the user-given name of this node and is
            // persistent across restarts and redeploys.
            this.projectDir = await ProjectManager.createProject(this.name, deps);
            // Record which config node owns the workspace, so the workspace can
            // be represented as a config node again if the flow file is lost
            await ProjectManager.saveWorkspaceMeta(this.projectDir, {
                id: this.id,
                name: this.name,
                dependencies: deps,
                environment: this.environment,
                startupTimeout: this.startupTimeout
            });
            this.warn(`Workspace created/updated at ${this.projectDir} for environment ${this.environment} with dependencies: ${deps.join(', ')}`);
            this.workerStatus = 'valid';
            return true;
        } catch (err) {
            this.error((RED._('python-workspace.errors.projectCreationFailed') || 'Failed to create project') + ': ' + err.message);
            this.workerStatus = 'error';
            return false;
        }
    };
    
    /**
     * Parse dependencies from newline-separated string
     * @returns {string[]} - Array of dependency specifications
     */
    PythonWorkspaceNode.prototype.parseDependencies = function() {
        if (!this.dependencies) {
            return [];
        }
        
        return this.dependencies
            .split('\n')
            .map(dep => dep.trim())
            .filter(dep => dep.length > 0);
    };

    /**
     * Check if configuration is valid
     * @returns {boolean}
     */
    PythonWorkspaceNode.prototype.isValid = function() {
        return this.workerStatus === 'valid' || this.workerStatus === 'ready' || this.workerStatus === 'starting';
    };

    /**
     * Create the worker manager instance
     */
    PythonWorkspaceNode.prototype.createWorkerManager = function() {
        this.workerManager = new WorkerManager({
            projectDir: this.projectDir,
            environment: this.environment,
            startupTimeout: this.startupTimeout
        });

        // Set up worker event listeners
        const node = this;
        this.workerManager.addListener(function(event, args) {
            node.handleWorkerEvent(event, args);
        });

        // Start the worker
        this.startWorker();
    };

    /**
     * Start the worker process
     */
    PythonWorkspaceNode.prototype.startWorker = function() {
        if (!this.workerManager) {
            return;
        }

        this.workerStatus = 'starting';
        this.updateStatus();

        const node = this;
        this.workerManager.start().then(function() {
            node.workerStatus = 'ready';
            node.updateStatus();
        }).catch(function(err) {
            node.workerStatus = 'error';
            node.error((RED._('python-workspace.errors.workerStartFailed') || 'Worker start failed') + ': ' + err.message);
            node.updateStatus();
        });
    };

    /**
     * Handle worker events
     * @param {string} event - event name
     * @param {...any} args - event arguments
     */
    PythonWorkspaceNode.prototype.handleWorkerEvent = function(event, args) {
        switch (event) {
            case 'ready':
                this.workerStatus = 'ready';
                this.updateStatus();
                break;
            case 'error':
                this.workerStatus = 'error';
                this.error(args);
                this.updateStatus();
                break;
            case 'stopped':
                this.workerStatus = 'stopped';
                this.updateStatus();
                break;
        }
    };

    /**
     * Update node status
     */
    PythonWorkspaceNode.prototype.updateStatus = function() {
        let statusText = '';
        let statusClass = '';

        if (!this.isValid()) {
            statusText = 'Invalid configuration';
            statusClass = 'red';
        } else {
            switch (this.workerStatus) {
                case 'starting':
                    statusText = 'Starting Python workspace';
                    statusClass = 'yellow';
                    break;
                case 'ready':
                    statusText = 'Python workspace ready';
                    statusClass = 'green';
                    break;
                case 'error':
                    statusText = 'Python workspace error';
                    statusClass = 'red';
                    break;
                case 'stopped':
                    statusText = 'Python workspace stopped';
                    statusClass = 'grey';
                    break;
                default:
                    statusText = 'Initializing';
                    statusClass = 'yellow';
            }
        }

        this.status({ fill: statusClass, shape: 'dot', text: statusText });
    };

    /**
     * Get the worker manager
     * @returns {WorkerManager|null}
     */
    PythonWorkspaceNode.prototype.getWorkerManager = function() {
        return this.workerManager;
    };

    /**
     * Clean up resources
     * @param {Function} [done] - callback when done
     */
    PythonWorkspaceNode.prototype.cleanup = async function(done) {
        const cleanupDone = () => {
            if (done) {
                done();
            }
        };

        try {
            if (this.workerManager) {
                await this.workerManager.stop();
                this.workerManager = null;
            }
            
            // The workspace is persistent and named after this node's name, so
            // it is kept for reuse across restarts and redeploys; only the
            // worker process is stopped here
            this.projectDir = null;
            
            this.workerStatus = 'stopped';
            this.updateStatus();
            cleanupDone();
        } catch (err) {
            this.error('Error during cleanup: ' + err.message);
            cleanupDone();
        }
    };
    RED.nodes.registerType("python-workspace", PythonWorkspaceNode, {
        credentials: {
            // Future: may include credentials for private registries
        }
    });
};

