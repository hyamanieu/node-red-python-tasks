// lib/protocol.js - JSON-lines protocol with correlation IDs
// Manages framing, correlation IDs, and pending request table

const { randomUUID } = require('crypto');

/**
 * Protocol manager for JSON-lines communication with Python worker
 * Handles message framing, correlation IDs, and pending request tracking
 */
class Protocol {
    constructor() {
        this.pendingRequests = new Map(); // Map<id, {resolve, reject, timer}>
        this.messageBuffer = '';
        this.nextId = () => randomUUID().replace(/-/g, '');
        this.listeners = [];
    }

    /**
     * Create a request ID and return the formatted request message
     * @param {string} op - operation type ('define', 'call', 'ping')
     * @param {object} data - request data (will be merged with id and op)
     * @returns {string} - formatted JSON-lines message
     */
    createRequest(op, data) {
        const id = this.nextId();
        const request = {
            id,
            op,
            ...data
        };
        return JSON.stringify(request) + '\n';
    }

    /**
     * Send a request and get a promise that resolves with the response
     * Call this after sending the formatted message to the worker
     * @param {string} id - the request ID you used
     * @param {number} [timeout] - request timeout in ms, 0 disables
     * @returns {Promise<object>} - resolves with response message, rejects on error or timeout
     */
    waitForResponse(id, timeout) {
        return new Promise((resolve, reject) => {
            const entry = {
                resolve,
                reject,
                timer: null
            };

            this.pendingRequests.set(id, entry);

            // Set up timeout if specified and > 0
            if (timeout && timeout > 0) {
                entry.timer = setTimeout(() => {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request timeout after ${timeout}ms`));
                }, timeout);
            }
        });
    }

    /**
     * Process incoming data from worker
     * @param {string} data - raw message data (may contain multiple lines)
     * @returns {object[]} - array of parsed messages
     */
    processIncoming(data) {
        const messages = [];
        this.messageBuffer += data;

        // Split by newlines
        const lines = this.messageBuffer.split('\n');
        this.messageBuffer = lines.pop() || ''; // Keep incomplete last line

        for (const line of lines) {
            if (line.trim() === '') continue;

            try {
                const message = JSON.parse(line);
                messages.push(message);
                this.handleMessage(message);
            } catch (err) {
                // Log but don't crash on malformed JSON
                console.error(`[protocol] Failed to parse message: ${line}`, err);
            }
        }

        return messages;
    }

    /**
     * Handle parsed incoming message
     * @param {object} message - parsed JSON message
     */
    handleMessage(message) {
        // Check if this is a readiness notification
        if (message.op === 'ready') {
            this.notifyListeners('ready', message);
            return;
        }

        // Check if this is a response to a pending request
        if (message.id && this.pendingRequests.has(message.id)) {
            const entry = this.pendingRequests.get(message.id);

            // Clear timeout
            if (entry.timer) {
                clearTimeout(entry.timer);
            }

            // Remove from pending
            this.pendingRequests.delete(message.id);

            if (message.ok) {
                entry.resolve(message);
            } else {
                const error = new Error(message.error?.message || 'Unknown error');
                error.type = message.error?.type;
                error.traceback = message.error?.traceback;
                error.response = message;
                entry.reject(error);
            }
        } else if (message.id) {
            // Response to unknown request ID - log but don't crash
            console.warn(`[protocol] Response for unknown request ID: ${message.id}`);
        } else if (message.op) {
            // Unknown op without ID - log it
            console.warn(`[protocol] Unknown message type: ${message.op}`);
        }
    }

    /**
     * Format a message for sending (JSON + newline)
     * @param {object} message - message to format
     * @returns {string} - formatted message
     */
    formatMessage(message) {
        return JSON.stringify(message) + '\n';
    }

    /**
     * Clear all pending requests (e.g., on cleanup)
     */
    clearAll() {
        for (const [id, entry] of this.pendingRequests) {
            if (entry.timer) {
                clearTimeout(entry.timer);
            }
            entry.reject(new Error('Connection closed'));
        }
        this.pendingRequests.clear();
        this.messageBuffer = '';
    }

    /**
     * Add a listener for protocol events
     * @param {Function} listener - callback(eventName, ...args)
     */
    addListener(listener) {
        this.listeners.push(listener);
    }

    /**
     * Remove a listener
     * @param {Function} listener - callback to remove
     */
    removeListener(listener) {
        this.listeners = this.listeners.filter(l => l !== listener);
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
                console.error(`[protocol] Error in listener for ${event}:`, err);
            }
        }
    }
}

module.exports = Protocol;

