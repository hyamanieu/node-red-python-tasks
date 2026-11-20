#!/usr/bin/env node
/**
 * Runs the pure-Python unit tests in python/tests with the stdlib unittest
 * runner — no extra dependencies (pytest is deliberately not required).
 *
 * Skips gracefully (exit 0) when no python3 is on PATH, mirroring the
 * self-skip convention of test/lib/worker_modes_spec.js, so `npm test`
 * still works on hosts without Python.
 *
 * Wired into `npm test` after the mocha suite in package.json.
 */
'use strict';

const { spawnSync, execFileSync } = require('child_process');
const path = require('path');

try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
} catch (err) {
    console.log('python3 not found on PATH - skipping python/tests (stdlib unittest suite)');
    process.exit(0);
}

const root = path.join(__dirname, '..');
const pythonDir = path.join(root, 'python');

const env = Object.assign({}, process.env, {
    PYTHONPATH: pythonDir + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : '')
});

const result = spawnSync(
    'python3',
    ['-m', 'unittest', 'discover', '-s', path.join(pythonDir, 'tests'), '-p', 'test_*.py', '-v'],
    { cwd: root, env, stdio: 'inherit' }
);

if (result.error) {
    console.error('failed to start python3 -m unittest:', result.error.message);
    process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
