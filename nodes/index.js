// Node-RED Python Tasks - Node Exports
// This file is referenced by package.json main but Node-RED loads nodes individually

// The actual nodes are loaded by Node-RED from the node-red.nodes mapping in package.json
// This file can be empty or can re-export the nodes for other uses

module.exports = {
    // These are loaded individually by Node-RED, but we export them here for completeness
    get pythonWorkspace() {
        return require('./python-workspace');
    },
    get pythonFunction() {
        return require('./python-function');
    },
    get pythonRun() {
        return require('./python-run');
    }
};
