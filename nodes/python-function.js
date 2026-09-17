// python-function node - execute Python functions
// Phase 0: stub implementation

module.exports = function(RED) {
    function PythonFunctionNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.env = config.env;
        this.func = config.func;
        
        var node = this;
        
        node.on('input', function(msg) {
            // Phase 0: stub - just pass through
            node.send(msg);
        });
    }
    RED.nodes.registerType("python-function", PythonFunctionNode);
};
