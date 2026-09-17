# Dockerfile for Node-RED with node-red-python-tasks development setup
# Uses Node-RED 4.1.15 with Node.js 22 (Alpine Linux based)

FROM nodered/node-red:4.1.15-22

# Switch to root to perform installation
USER root

# Copy package.json and entrypoint first
COPY package.json /data/node-red-node-red-python-tasks/
COPY entrypoint.sh /usr/src/node-red/entrypoint.sh
RUN chmod +x /usr/src/node-red/entrypoint.sh

# Set up pixi home directory (this must be set before npm install)
ENV PIXI_HOME=/usr/src/node-red/.pixi

# Install pixi via npm preinstall script
WORKDIR /data/node-red-node-red-python-tasks
RUN npm install --no-save

# Add pixi to PATH
ENV PATH="$PIXI_HOME/bin:$PATH"

# Copy the nodes directory
COPY nodes/ /data/node-red-node-red-python-tasks/nodes/

# The entrypoint script will create the symlink from node_modules to the mounted package

# Switch back to the node-red user
USER node-red

# Set HOME to /data so Node-RED uses it as the user directory
ENV HOME=/data

# Switch to the Node-RED working directory
WORKDIR /data

# Use the custom entrypoint
ENTRYPOINT ["/usr/src/node-red/entrypoint.sh"]
