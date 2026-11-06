#!/bin/bash

# Set HOME to /data so Node-RED uses /data as its user directory
export HOME=/data

# Install devDependencies for testing (they need to be in the mounted volume)
cd /data/node-red-node-red-python-tasks
if [ ! -d "node_modules" ]; then
    npm install --include=dev
fi

# Create symlink from node_modules to our package directory (scoped npm name)
# The package directory is mounted from the host at /data/node-red-node-red-python-tasks
mkdir -p /data/node_modules/@hyamanieu
ln -sfn /data/node-red-node-red-python-tasks /data/node_modules/@hyamanieu/node-red-python-tasks
# Remove the legacy unscoped symlink from before the package was renamed
rm -f /data/node_modules/node-red-python-tasks

# Start Node-RED with the correct user directory
# This matches the original Node-RED Docker image entrypoint
exec /usr/local/bin/node $NODE_OPTIONS /usr/src/node-red/node_modules/node-red/red.js --userDir /data $FLOWS "${@}"
