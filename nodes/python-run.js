// python-run node - execute Python commands
// Executes commands via pixi run

const { spawn } = require('child_process');
const path = require('path');

module.exports = function(RED) {
    /**
     * Python Run Execution Node
     * Executes Python commands via pixi run
     */
    function PythonRunNode(config) {
        RED.nodes.createNode(this, config);

        // Store configuration
        this.name = config.name || '';
        this.env = config.env || '';
        this.command = config.command || '';
        this.args = config.args || '';
        this.timeout = parseInt(config.timeout) || 30000;

        // Get the environment config node
        this.envNode = RED.nodes.getNode(this.env);

        // Node status
        this.nodeStatus = 'initializing';

        // Validate configuration
        if (!this.envNode || !this.envNode.isValid()) {
            this.error(RED._('python-run.errors.invalidEnv') || 'Invalid Python environment configuration');
            this.nodeStatus = 'error';
        } else if (!this.command) {
            this.error(RED._('python-run.errors.noCommand') || 'Command is required');
            this.nodeStatus = 'error';
        } else {
            this.nodeStatus = 'ready';
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
     * Handle input message
     * @param {object} msg - input message
     */
    PythonRunNode.prototype.handleInput = function(msg) {
        const node = this;

        // Check if we have a valid environment
        if (!node.envNode || !node.envNode.isValid()) {
            const err = new Error(RED._('python-run.errors.invalidEnv') || 'Invalid Python environment configuration');
            node.error(err, msg);
            return;
        }

        if (!node.command) {
            const err = new Error(RED._('python-run.errors.noCommand') || 'Command is required');
            node.error(err, msg);
            return;
        }

        node.nodeStatus = 'running';
        node.updateStatus();

        // Parse fixed args (comma-separated string)
        const fixedArgs = node.args
            .split(',')
            .map(arg => arg.trim())
            .filter(arg => arg.length > 0);

        // Build the argument list based on payload type
        let processArgs = [];

        if (Array.isArray(msg.payload)) {
            // Array payload: each element becomes a positional argument
            processArgs = msg.payload.map(arg => String(arg));
        } else if (typeof msg.payload === 'object' && msg.payload !== null) {
            // Object payload: pass as single JSON string
            processArgs = [JSON.stringify(msg.payload)];
        } else if (msg.payload !== undefined && msg.payload !== null) {
            // Scalar payload: pass as string
            processArgs = [String(msg.payload)];
        }

        // Combine fixed args and payload args
        const allArgs = [...fixedArgs, ...processArgs];

        // Execute via pixi run
        const environment = node.envNode.environment || 'default';
        const projectDir = node.envNode.projectDir;

        // Get pixi path
        const pixiPath = process.env.PIXI_HOME ? path.join(process.env.PIXI_HOME, 'bin', 'pixi') : 'pixi';

        const pixiArgs = ['run', '-e', environment, '-x', node.command, ...allArgs];

        // Set PYTHONPATH to include the python directory
        const env = {
            ...process.env,
            PYTHONPATH: path.join(__dirname, '..', 'python')
        };

        console.log(`[python-run] Executing: ${pixiPath} ${pixiArgs.join(' ')} in ${projectDir}`);

        const childProcess = spawn(pixiPath, pixiArgs, {
            cwd: projectDir,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        // Set up timeout
        let timedOut = false;
        const timeoutMs = node.timeout === 0 ? 0 : node.timeout;

        let timeoutHandle = null;
        if (timeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                timedOut = true;
                childProcess.kill();
                const err = new Error(`Command timed out after ${timeoutMs}ms`);
                err.name = 'TimeoutError';
                node.error(err, msg);
                node.nodeStatus = 'error';
                node.updateStatus();
            }, timeoutMs);
        }

        // Collect stdout and stderr
        let stdout = '';
        let stderr = '';

        childProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        childProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        childProcess.on('close', (code) => {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }

            if (timedOut) {
                return; // Already handled timeout
            }

            if (code === 0) {
                // Success - send stdout as payload
                const newMsg = { ...msg, payload: stdout.trim() };
                node.send(newMsg);
                node.nodeStatus = 'ready';
                node.updateStatus();
            } else {
                // Error - create error with exit code
                const err = new Error(`Command failed with exit code ${code}`);
                err.exitCode = code;
                err.stderr = stderr;
                err.stdout = stdout;
                node.error(err, msg);
                node.nodeStatus = 'error';
                node.updateStatus();
            }
        });

        childProcess.on('error', (err) => {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }

            if (!timedOut) {
                node.error(err, msg);
                node.nodeStatus = 'error';
                node.updateStatus();
            }
        });
    };

    /**
     * Update node status display
     */
    PythonRunNode.prototype.updateStatus = function() {
        let statusText = '';
        let statusClass = '';

        switch (this.nodeStatus) {
            case 'initializing':
                statusText = 'Initializing';
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
    PythonRunNode.prototype.cleanup = function(done) {
        // Nothing special to clean up for this node
        if (done) {
            done();
        }
    };

    RED.nodes.registerType("python-run", PythonRunNode);
};

