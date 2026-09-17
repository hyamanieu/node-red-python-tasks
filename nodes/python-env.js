// python-env node - configuration node for Python environments
// Phase 0: stub implementation

module.exports = function(RED) {
    function PythonEnvNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
    }
    RED.nodes.registerType("python-env", PythonEnvNode, {
        credentials: {
            // Future: may include credentials for private registries
        }
    });
};
