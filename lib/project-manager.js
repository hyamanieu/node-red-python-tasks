// lib/project-manager.js - Manage temporary pixi projects for python-env nodes

const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

/**
 * Manages temporary pixi projects for python-env nodes
 * Creates a temporary directory with a generated pixi.toml from dependency specifications
 */
class ProjectManager {
    /**
     * Create a temporary pixi project directory with the given dependencies
     * @param {string[]} dependencies - Array of dependency specs (e.g., ["python=3.9", "numpy"])
     * @returns {Promise<string>} - Path to the temporary project directory
     */
    static async createProject(dependencies = []) {
        // Create a unique temporary directory name
        const tempDirName = `node-red-python-env-${uuidv4()}`;
        const tempBaseDir = process.env.NODE_RED_PYTHON_TEMP_DIR || os.tmpdir();
        const projectDir = path.join(tempBaseDir, tempDirName);
        
        // Create the directory
        await fs.promises.mkdir(projectDir, { recursive: true });
        
        // Generate pixi.toml content
        const tomlContent = this.generatePixiToml(dependencies);
        
        // Write pixi.toml
        const tomlPath = path.join(projectDir, 'pixi.toml');
        await fs.promises.writeFile(tomlPath, tomlContent);
        
        return projectDir;
    }
    
    /**
     * Generate pixi.toml content from dependency specifications
     * @param {string[]} dependencies - Array of dependency specs
     * @returns {string} - pixi.toml content as string
     */
    static generatePixiToml(dependencies = []) {
        // Filter out empty dependencies and trim whitespace
        const filteredDeps = dependencies
            .filter(dep => dep && dep.trim().length > 0)
            .map(dep => dep.trim());
        
        // Format dependencies for TOML
        const depsToml = filteredDeps.length > 0 
            ? filteredDeps.map(dep => `    "${dep}"`).join(',\n')
            : '';
        
        // Generate the TOML file
        const platformStr = this.getPlatform();
        const tomlLines = [
            '[project]',
            'name = "node-red-python-env"',
            'version = "0.1.0"',
            'description = "Node-RED Python environment"',
            'authors = []',
            'channels = ["conda-forge"]',
            `platforms = ["${platformStr}"]`,
            '',
            '[environments]',
            `default = [${depsToml}`,
            ']',
            '',
            '[tool.pixi.simple]',
            'pm = "pip"',
            ''
        ];
        
        return tomlLines.join('\n');
    }
    
    /**
     * Get the current platform for pixi
     * @returns {string}
     */
    static getPlatform() {
        const platform = process.platform;
        const arch = process.arch;
        
        if (platform === 'linux' && arch === 'x64') return 'linux-64';
        if (platform === 'linux' && arch === 'arm64') return 'linux-aarch64';
        if (platform === 'darwin' && arch === 'x64') return 'osx-64';
        if (platform === 'darwin' && arch === 'arm64') return 'osx-arm64';
        if (platform === 'win32' && arch === 'x64') return 'win-64';
        
        // Default to linux-64 for containers
        return 'linux-64';
    }
    
    /**
     * Clean up a temporary project directory
     * @param {string} projectDir - Path to the project directory
     * @returns {Promise<void>}
     */
    static async cleanupProject(projectDir) {
        try {
            // Remove the directory and all its contents
            await fs.promises.rm(projectDir, { recursive: true, force: true });
        } catch (err) {
            // Ignore errors if directory doesn't exist
            if (err.code !== 'ENOENT') {
                console.warn(`[project-manager] Failed to cleanup ${projectDir}: ${err.message}`);
            }
        }
    }
}

module.exports = ProjectManager;
