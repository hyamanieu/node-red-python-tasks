// python-env node - configuration node for Python environments
// Manages pixi-based Python environments and persistent worker processes

const path = require('path');
const fs = require('fs');
const WorkerManager = require('../lib/worker');
const ProjectManager = require('../lib/project-manager');

module.exports = function(RED) {
    /**
     * Python Environment Configuration Node
     * Defines a Python environment by listing dependencies, internally manages a pixi project
     */
    function PythonEnvNode(config) {
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
    PythonEnvNode.prototype.validateConfig = async function() {
        // Check if dependencies are provided
        if (!this.dependencies || this.dependencies.trim().length === 0) {
            this.error(RED._('python-env.errors.noDependencies') || 'At least one dependency is required');
            this.workerStatus = 'error';
            return false;
        }

        // Parse dependencies from newline-separated string
        const deps = this.parseDependencies();
        
        if (deps.length === 0) {
            this.error(RED._('python-env.errors.invalidDependencies') || 'Invalid dependency specifications');
            this.workerStatus = 'error';
            return false;
        }

        try {
            // Create a temporary project directory with the dependencies
            this.projectDir = await ProjectManager.createProject(deps);
            this.workerStatus = 'valid';
            return true;
        } catch (err) {
            this.error(RED._('python-env.errors.projectCreationFailed') || `Failed to create project: ${err.message}`);
            this.workerStatus = 'error';
            return false;
        }
    };
    
    /**
     * Parse dependencies from newline-separated string
     * @returns {string[]} - Array of dependency specifications
     */
    PythonEnvNode.prototype.parseDependencies = function() {
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
    PythonEnvNode.prototype.isValid = function() {
        return this.workerStatus === 'valid' || this.workerStatus === 'ready' || this.workerStatus === 'starting';
    };

    /**
     * Create the worker manager instance
     */
    PythonEnvNode.prototype.createWorkerManager = function() {
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
    PythonEnvNode.prototype.startWorker = function() {
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
            node.error((RED._('python-env.errors.workerStartFailed') || 'Worker start failed') + ': ' + err.message);
            node.updateStatus();
        });
    };

    /**
     * Handle worker events
     * @param {string} event - event name
     * @param {...any} args - event arguments
     */
    PythonEnvNode.prototype.handleWorkerEvent = function(event, args) {
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
    PythonEnvNode.prototype.updateStatus = function() {
        let statusText = '';
        let statusClass = '';

        if (!this.isValid()) {
            statusText = 'Invalid configuration';
            statusClass = 'red';
        } else {
            switch (this.workerStatus) {
                case 'starting':
                    statusText = 'Starting Python environment';
                    statusClass = 'yellow';
                    break;
                case 'ready':
                    statusText = 'Python environment ready';
                    statusClass = 'green';
                    break;
                case 'error':
                    statusText = 'Python environment error';
                    statusClass = 'red';
                    break;
                case 'stopped':
                    statusText = 'Python environment stopped';
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
    PythonEnvNode.prototype.getWorkerManager = function() {
        return this.workerManager;
    };

    /**
     * Clean up resources
     * @param {Function} [done] - callback when done
     */
    PythonEnvNode.prototype.cleanup = async function(done) {
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
            
            // Clean up the temporary project directory
            if (this.projectDir) {
                await ProjectManager.cleanupProject(this.projectDir);
                this.projectDir = null;
            }
            
            this.workerStatus = 'stopped';
            this.updateStatus();
            cleanupDone();
        } catch (err) {
            this.error('Error during cleanup: ' + err.message);
            cleanupDone();
        }
    };

    RED.nodes.registerType("python-env", PythonEnvNode, {
        credentials: {
            // Future: may include credentials for private registries
        }
    });
};

