// python-function node - execute Python functions
// Uses persistent worker process for low-latency execution

const { randomUUID } = require('crypto');

module.exports = function(RED) {
    /**
     * Python Function Execution Node
     * Executes Python function body via persistent worker process
     */
    function PythonFunctionNode(config) {
        RED.nodes.createNode(this, config);

        // Store configuration
        this.name = config.name || '';
        this.workspace = config.workspace || '';
        this.functionBody = config.functionBody || '';
        this.imports = config.imports || '';
        this.timeout = parseInt(config.timeout) || 30000;

        // Get the workspace config node
        this.workspaceNode = RED.nodes.getNode(this.workspace);

        // Function identifier (based on node ID and function hash)
        this.functionId = `func_${this.id}`;

        // Track if function is defined in worker
        this.isFunctionDefined = false;

        // Pending messages queue (for when worker is not ready)
        this.pendingMessages = [];

        // Node status
        this.nodeStatus = 'initializing';

        // Check if we have a valid environment
        if (!this.workspaceNode || !this.workspaceNode.isValid()) {
            this.error(RED._('python-function.errors.invalidWorkspace') || 'Invalid Python workspace configuration');
            this.nodeStatus = 'error';
        } else {
            // Wait for worker to be ready, then define function
            this.waitForWorkerReady();
        }

        // Handle input messages
        const node = this;
        this.on('input', function(msg) {
            node.handleInput(msg);
        });

        // Handle node close
        this.on('close', function(done) {
            node.cleanup(done);
        });
    }

    /**
     * Wait for worker to be ready and define the function
     */
    PythonFunctionNode.prototype.waitForWorkerReady = function() {
        const node = this;

        if (!node.workspaceNode || !node.workspaceNode.isValid()) {
            node.nodeStatus = 'error';
            node.updateStatus();
            return;
        }

        const workerManager = node.workspaceNode.getWorkerManager();
        if (!workerManager) {
            node.nodeStatus = 'error';
            node.updateStatus();
            return;
        }

        // Check if worker is already ready
        if (workerManager.isReady()) {
            node.defineFunction();
            return;
        }

        // Wait for ready event
        node.nodeStatus = 'waiting';
        node.updateStatus();

        workerManager.addListener(function(event, args) {
            if (event === 'ready') {
                node.defineFunction();
                // Remove this listener after first ready
                workerManager.removeListener(arguments.callee);
            } else if (event === 'error') {
                node.nodeStatus = 'error';
                node.updateStatus();
            }
        });
    };

    /**
     * Define the function in the worker
     */
    PythonFunctionNode.prototype.defineFunction = function() {
        const node = this;

        if (!node.workspaceNode || !node.workspaceNode.isValid()) {
            node.nodeStatus = 'error';
            node.updateStatus();
            return;
        }

        const workerManager = node.workspaceNode.getWorkerManager();
        if (!workerManager || !workerManager.isReady()) {
            node.nodeStatus = 'waiting';
            node.updateStatus();
            return;
        }

        // Parse imports (comma-separated string)
        const imports = node.imports
            .split(',')
            .map(imp => imp.trim())
            .filter(imp => imp.length > 0);

        node.nodeStatus = 'defining';
        node.updateStatus();

        workerManager.defineFunction(node.functionId, node.functionBody, imports, node.timeout)
            .then(() => {
                node.isFunctionDefined = true;
                node.nodeStatus = 'ready';
                node.updateStatus();
                
                // Process any pending messages
                node.processPendingMessages();
            })
            .catch((err) => {
                node.nodeStatus = 'error';
                node.error(RED._('python-function.errors.defineFailed') || 'Failed to define function: ' + err.message);
                node.updateStatus();
            });
    };

    /**
     * Handle input message
     * @param {object} msg - input message
     */
    PythonFunctionNode.prototype.handleInput = function(msg) {
        const node = this;

        // If function not yet defined, queue the message
        if (!node.isFunctionDefined || !node.workspaceNode || !node.workspaceNode.isValid()) {
            node.pendingMessages.push(msg);
            node.nodeStatus = 'queued';
            node.updateStatus();
            return;
        }

        const workerManager = node.workspaceNode.getWorkerManager();
        if (!workerManager || !workerManager.isReady()) {
            node.pendingMessages.push(msg);
            node.nodeStatus = 'queued';
            node.updateStatus();
            return;
        }

        // Process the message
        node.nodeStatus = 'running';
        node.updateStatus();

        const callTimeout = node.timeout === 0 ? 0 : node.timeout;

        workerManager.callFunction(node.functionId, msg.payload, callTimeout)
            .then((result) => {
                // Preserve all msg properties except payload
                const newMsg = { ...msg, payload: result };
                node.send(newMsg);
                node.nodeStatus = 'ready';
                node.updateStatus();
            })
            .catch((err) => {
                // Create error with type, message, traceback
                const errorInfo = {
                    type: err.type || 'Error',
                    message: err.message || 'Unknown error',
                    traceback: err.traceback || '',
                    source: node.functionBody
                };
                
                // Report error via node.error so catch nodes can handle it
                node.error(err, msg);
                
                node.nodeStatus = 'error';
                node.updateStatus();
            });
    };

    /**
     * Process pending messages when worker becomes ready
     */
    PythonFunctionNode.prototype.processPendingMessages = function() {
        const node = this;

        if (node.pendingMessages.length === 0) {
            return;
        }

        // Only process if we're ready
        if (!node.isFunctionDefined || !node.workspaceNode || !node.workspaceNode.isValid()) {
            return;
        }

        const workerManager = node.workspaceNode.getWorkerManager();
        if (!workerManager || !workerManager.isReady()) {
            return;
        }

        // Process each pending message
        while (node.pendingMessages.length > 0) {
            const msg = node.pendingMessages.shift();
            node.handleInput(msg);
        }
    };

    /**
     * Update node status display
     */
    PythonFunctionNode.prototype.updateStatus = function() {
        let statusText = '';
        let statusClass = '';

        switch (this.nodeStatus) {
            case 'initializing':
                statusText = 'Initializing';
                statusClass = 'yellow';
                break;
            case 'waiting':
                statusText = 'Waiting for workspace';
                statusClass = 'yellow';
                break;
            case 'defining':
                statusText = 'Defining function';
                statusClass = 'yellow';
                break;
            case 'queued':
                statusText = 'Messages queued';
                statusClass = 'yellow';
                break;
            case 'running':
                statusText = 'Running';
                statusClass = 'blue';
                break;
            case 'ready':
                statusText = 'Ready';
                statusClass = 'green';
                break;
            case 'error':
                statusText = 'Error';
                statusClass = 'red';
                break;
            default:
                statusText = 'Unknown';
                statusClass = 'grey';
        }

        this.status({ fill: statusClass, shape: 'dot', text: statusText });
    };

    /**
     * Clean up resources
     * @param {Function} [done] - callback when done
     */
    PythonFunctionNode.prototype.cleanup = function(done) {
        this.pendingMessages = [];
        this.isFunctionDefined = false;
        
        if (done) {
            done();
        }
    };

    RED.nodes.registerType("python-function", PythonFunctionNode);
};

