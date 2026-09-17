// python-run node - execute Python commands
// Phase 0: stub implementation

module.exports = function(RED) {
    function PythonRunNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.env = config.env;
        this.command = config.command;
        
        var node = this;
        
        node.on('input', function(msg) {
            // Phase 0: stub - just pass through
            node.send(msg);
        });
    }
    RED.nodes.registerType("python-run", PythonRunNode);
};
