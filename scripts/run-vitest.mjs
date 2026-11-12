// Runs Vitest inside Electron's bundled Node, so better-sqlite3 (built for Electron) loads in tests.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron') // resolves to the Electron binary path
const vitestPkg = require.resolve('vitest/package.json')
const vitest = join(dirname(vitestPkg), require(vitestPkg).bin.vitest)

// On Windows, a lower-case drive letter (VS Code's terminal starts in "c:\...") makes Vitest
// load two copies of itself and fail with "failed to find the runner". Normalize it.
const upperDrive = (path) => path.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
const cwd = upperDrive(process.cwd())

const child = spawn(electron, [upperDrive(vitest), ...process.argv.slice(2)], {
  cwd,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
