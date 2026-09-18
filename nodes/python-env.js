// python-env node - configuration node for Python environments
// Manages pixi-based Python environments and persistent worker processes

const path = require('path');
const fs = require('fs');
const WorkerManager = require('../lib/worker');

module.exports = function(RED) {
    /**
     * Python Environment Configuration Node
     * Holds the path to a directory containing a pixi.toml and the name of the pixi environment
     */
    function PythonEnvNode(config) {
        RED.nodes.createNode(this, config);

        // Store configuration
        this.name = config.name || '';
        this.projectDir = config.projectDir || '';
        this.environment = config.environment || 'default';
        this.startupTimeout = parseInt(config.startupTimeout) || 120000;

        // Worker manager instance
        this.workerManager = null;

        // Node status tracking
        this.workerStatus = 'initializing';

        // Validate configuration on creation
        this.validateConfig();

        // Create worker manager if config is valid
        if (this.isValid()) {
            this.createWorkerManager();
        }

        // Handle node close (redeploy or removal)
        const node = this;
        this.on('close', function(done) {
            node.cleanup(done);
        });
    }

    /**
     * Validate the configuration
     * @returns {boolean} - true if valid
     */
    PythonEnvNode.prototype.validateConfig = function() {
        // Check if project directory exists
        if (!this.projectDir) {
            this.error(RED._('python-env.errors.noProjectDir') || 'Project directory is required');
            this.workerStatus = 'error';
            return false;
        }

        // Check if directory exists
        if (!fs.existsSync(this.projectDir)) {
            this.error(RED._('python-env.errors.directoryNotFound', { dir: this.projectDir }) || `Directory not found: ${this.projectDir}`);
            this.workerStatus = 'error';
            return false;
        }

        // Check if pixi.toml exists
        const pixiTomlPath = path.join(this.projectDir, 'pixi.toml');
        if (!fs.existsSync(pixiTomlPath)) {
            this.error(RED._('python-env.errors.noPixiToml', { dir: this.projectDir }) || `No pixi.toml found in ${this.projectDir}`);
            this.workerStatus = 'error';
            return false;
        }

        // Config is valid
        this.workerStatus = 'valid';
        return true;
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

