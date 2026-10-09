// lib/worker.js - spawn, supervise, and manage Python worker processes

const { spawn } = require('child_process');
const path = require('path');
const Protocol = require('./protocol');

/**
 * Worker process manager
 * Handles spawning, supervision, restart with backoff, and cleanup of Python worker processes
 */
class WorkerManager {
    /**
     * @param {object} options - worker configuration
     * @param {string} options.projectDir - directory containing pixi.toml
     * @param {string} options.environment - pixi environment name (default: 'default')
     * @param {number} [options.startupTimeout=120000] - ms to wait for worker readiness
     * @param {string} [options.pythonPath] - path to python executable (defaults to 'python')
     */
    constructor(options) {
        this.options = {
            projectDir: options.projectDir,
            environment: options.environment || 'default',
            startupTimeout: options.startupTimeout || 120000,
            pythonPath: options.pythonPath || 'python'
        };

        this.workerProcess = null;
        this.protocol = new Protocol();
        this.status = 'stopped'; // 'stopped', 'starting', 'ready', 'error', 'stopping'
        this.restartCount = 0;
        this.backoffTimer = null;
        this.startupTimer = null;
        this.error = null;
        this.listeners = [];

        // Function definitions cache: Map<function_id, {source, imports}>
        this.functionDefinitions = new Map();

        // Track pending call promises
        this.pendingCalls = new Map();

        this.setupProtocolListeners();
    }

    /**
     * Set up protocol event listeners
     */
    setupProtocolListeners() {
        this.protocol.addListener((event, ...args) => {
            if (event === 'ready') {
                this.handleReady(...args);
            }
        });
    }

    /**
     * Start the worker process
     * @returns {Promise<void>} - resolves when worker is ready, rejects on failure
     */
    async start() {
        if (this.status === 'starting' || this.status === 'ready') {
            return;
        }

        this.status = 'starting';
        this.restartCount = 0;
        this.error = null;

        // Clear any existing backoff timer
        if (this.backoffTimer) {
            clearTimeout(this.backoffTimer);
            this.backoffTimer = null;
        }

        try {
            // First, ensure pixi install has been run
            await this.ensureInstalled();

            // Then start the worker process
            this.spawnWorker();

            // Set up startup timeout
            return new Promise((resolve, reject) => {
                this.startupTimer = setTimeout(() => {
                    this.stop();
                    reject(new Error(`Worker startup timed out after ${this.options.startupTimeout}ms`));
                }, this.options.startupTimeout);

                // The ready handler will resolve this promise
                this.once('ready', () => {
                    clearTimeout(this.startupTimer);
                    this.startupTimer = null;
                    resolve();
                });

                this.once('error', (err) => {
                    clearTimeout(this.startupTimer);
                    this.startupTimer = null;
                    reject(err);
                });
            });
        } catch (err) {
            this.status = 'error';
            this.error = err;
            throw err;
        }
    }

    /**
     * Get the pixi executable path
     * @returns {string}
     */
    getPixiPath() {
        // Check if PIXI_HOME is set (it should be in the container)
        if (process.env.PIXI_HOME) {
            return path.join(process.env.PIXI_HOME, 'bin', 'pixi');
        }
        // Fall back to just 'pixi' and let the system PATH resolve it
        return 'pixi';
    }

    /**
     * Ensure pixi install has been run for the environment
     * @returns {Promise<void>}
     */
    async ensureInstalled() {
        return new Promise((resolve, reject) => {
            // Get the pixi executable path
            const pixiPath = this.getPixiPath();

            // Run pixi install in the project directory
            const installProcess = spawn(pixiPath, ['install'], {
                cwd: this.options.projectDir,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            installProcess.stdout.on('data', (data) => {
                console.log(`[pixi install] ${data.toString().trim()}`);
            });

            installProcess.stderr.on('data', (data) => {
                console.error(`[pixi install] ${data.toString().trim()}`);
            });

            installProcess.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    // Log the error but don't fail - the environment might already be installed
                    console.warn(`[pixi install] pixi install exited with code ${code}, but continuing...`);
                    resolve();
                }
            });

            installProcess.on('error', (err) => {
                // Log the error but don't fail - pixi might not be available
                console.warn(`[pixi install] Failed to run pixi install: ${err.message}, but continuing...`);
                resolve();
            });
        });
    }

    /**
     * Spawn the worker process
     */
    spawnWorker() {
        // Build the command: pixi run -e <environment> python -m nrpyrun_worker
        const pixiPath = this.getPixiPath();
        const args = ['run', '-e', this.options.environment, '-m', this.options.pythonPath, 'nrpyrun_worker'];

        // Set PYTHONPATH to include the python directory
        const env = {
            ...process.env,
            PYTHONPATH: path.join(__dirname, '..', 'python')
        };

        console.log(`[worker] Spawning: ${pixiPath} ${args.join(' ')} in ${this.options.projectDir}`);

        this.workerProcess = spawn(pixiPath, args, {
            cwd: this.options.projectDir,
            env,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        // Set up process event handlers
        this.workerProcess.stdout.on('data', (data) => {
            this.protocol.processIncoming(data.toString());
        });

        this.workerProcess.stderr.on('data', (data) => {
            // Forward stderr to Node-RED log
            console.error(`[worker stderr] ${data.toString().trim()}`);
        });

        this.workerProcess.on('close', (code) => {
            this.handleProcessExit(code);
        });

        this.workerProcess.on('error', (err) => {
            this.handleProcessError(err);
        });
    }

    /**
     * Handle worker process ready message
     * @param {object} message - ready message from worker
     */
    handleReady(message) {
        console.log(`[worker] Worker ready: protocol=${message.protocol}, python=${message.python}`);
        this.status = 'ready';
        this.restartCount = 0;
        this.notifyListeners('ready');
    }

    /**
     * Handle worker process exit
     * @param {number} code - exit code
     */
    handleProcessExit(code) {
        console.log(`[worker] Process exited with code ${code}`);
        this.workerProcess = null;

        if (this.status === 'stopping') {
            // Expected shutdown
            this.status = 'stopped';
            this.notifyListeners('stopped');
            return;
        }

        // Unexpected exit - trigger restart with backoff
        this.status = 'error';
        this.error = new Error(`Worker process exited with code ${code}`);

        // Attempt restart with exponential backoff
        this.scheduleRestart();
    }

    /**
     * Handle worker process spawn error
     * @param {Error} err - error from spawn
     */
    handleProcessError(err) {
        console.error(`[worker] Process error: ${err.message}`);
        this.workerProcess = null;

        if (this.status === 'stopping') {
            this.status = 'stopped';
            this.notifyListeners('stopped');
            return;
        }

        this.status = 'error';
        this.error = err;

        // Attempt restart with exponential backoff
        this.scheduleRestart();
    }

    /**
     * Schedule restart with exponential backoff
     */
    scheduleRestart() {
        this.restartCount++;

        // Calculate backoff: min(2^restartCount * 100, 30000) ms
        const backoffMs = Math.min(Math.pow(2, this.restartCount) * 100, 30000);

        console.log(`[worker] Scheduling restart (attempt ${this.restartCount}) in ${backoffMs}ms`);

        this.backoffTimer = setTimeout(() => {
            this.backoffTimer = null;
            this.start().catch((err) => {
                console.error(`[worker] Failed to restart: ${err.message}`);
            });
        }, backoffMs);

        this.notifyListeners('error', this.error);
    }

    /**
     * Stop the worker process
     * @returns {Promise<void>}
     */
    async stop() {
        if (this.status === 'stopped' || this.status === 'stopping') {
            return;
        }

        this.status = 'stopping';

        // Clear backoff timer
        if (this.backoffTimer) {
            clearTimeout(this.backoffTimer);
            this.backoffTimer = null;
        }

        // Clear startup timer
        if (this.startupTimer) {
            clearTimeout(this.startupTimer);
            this.startupTimer = null;
        }

        // Clear protocol pending requests
        this.protocol.clearAll();

        if (this.workerProcess) {
            // Try to send a ping or just kill the process
            // For now, just kill it
            this.workerProcess.kill();
            this.workerProcess = null;
        }

        this.status = 'stopped';
        this.notifyListeners('stopped');
    }

    /**
     * Define a function in the worker
     * @param {string} functionId - unique identifier for the function
     * @param {string} source - Python function body (code that uses payload as input)
     * @param {string[]} imports - module names to pre-import
     * @param {number} [timeout] - timeout in ms
     * @returns {Promise<void>}
     */
    async defineFunction(functionId, source, imports, timeout) {
        // Cache the definition locally
        this.functionDefinitions.set(functionId, { source, imports });

        const message = this.protocol.createRequest('define', {
            function_id: functionId,
            source,
            imports
        });

        // Extract the ID from the message
        const request = JSON.parse(message.trim());
        const id = request.id;

        // Send the message
        if (this.workerProcess && this.workerProcess.stdout.writable) {
            this.workerProcess.stdin.write(message);
        } else {
            throw new Error('Worker process not available');
        }

        // Wait for response
        return this.protocol.waitForResponse(id, timeout);
    }

    /**
     * Call a defined function in the worker
     * @param {string} functionId - unique identifier for the function
     * @param {any} payload - input payload (will be JSON-serialized)
     * @param {number} [timeout] - timeout in ms
     * @returns {Promise<any>} - resolves with function result
     */
    async callFunction(functionId, payload, timeout) {
        const message = this.protocol.createRequest('call', {
            function_id: functionId,
            payload
        });

        // Extract the ID from the message
        const request = JSON.parse(message.trim());
        const id = request.id;

        // Send the message
        if (this.workerProcess && this.workerProcess.stdin.writable) {
            this.workerProcess.stdin.write(message);
        } else {
            throw new Error('Worker process not available');
        }

        // Wait for response and extract result
        const response = await this.protocol.waitForResponse(id, timeout);
        
        if (response.ok) {
            return response.result;
        } else {
            const error = new Error(response.error?.message || 'Unknown error');
            error.type = response.error?.type;
            error.traceback = response.error?.traceback;
            throw error;
        }
    }

    /**
     * Send a ping to check worker health
     * @param {number} [timeout] - timeout in ms
     * @returns {Promise<void>}
     */
    async ping(timeout) {
        const message = this.protocol.createRequest('ping', {});

        // Extract the ID from the message
        const request = JSON.parse(message.trim());
        const id = request.id;

        // Send the message
        if (this.workerProcess && this.workerProcess.stdin.writable) {
            this.workerProcess.stdin.write(message);
        } else {
            throw new Error('Worker process not available');
        }

        // Wait for response
        await this.protocol.waitForResponse(id, timeout);
    }

    /**
     * Get current status
     * @returns {string}
     */
    getStatus() {
        return this.status;
    }

    /**
     * Get last error
     * @returns {Error|null}
     */
    getError() {
        return this.error;
    }

    /**
     * Check if worker is ready
     * @returns {boolean}
     */
    isReady() {
        return this.status === 'ready';
    }

    /**
     * Add an event listener
     * @param {Function} listener - callback(event, ...args)
     */
    addListener(listener) {
        this.listeners.push(listener);
    }

    /**
     * Remove an event listener
     * @param {Function} listener - callback to remove
     */
    removeListener(listener) {
        this.listeners = this.listeners.filter(l => l !== listener);
    }

    /**
     * Add a one-time event listener
     * @param {string} event - event name
     * @param {Function} listener - callback
     */
    once(event, listener) {
        const onceListener = (...args) => {
            listener(...args);
            this.removeListener(onceListener);
        };
        this.addListener(onceListener);
    }

    /**
     * Notify all listeners of an event
     * @param {string} event - event name
     * @param {...any} args - event arguments
     */
    notifyListeners(event, ...args) {
        for (const listener of this.listeners) {
            try {
                listener(event, ...args);
            } catch (err) {
                console.error(`[worker] Error in listener for ${event}:`, err);
            }
        }
    }
}

module.exports = WorkerManager;
