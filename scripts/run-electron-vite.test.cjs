const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { join, dirname } = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const source = readFileSync(join(__dirname, 'run-electron-vite.cjs'), 'utf8')

function launch(command, forwarded = []) {
  const child = new EventEmitter()
  let invocation, exit
  const dependency = join('C:\\Program Files', 'Twilight Echo', 'node_modules', 'electron-vite', 'package.json')
  const mockRequire = (name) => name === 'node:child_process'
    ? { spawn: (...args) => { invocation = args; return child } }
    : require(name)
  mockRequire.resolve = () => dependency
  const process = { argv: ['node', 'launcher', command, ...forwarded], platform: 'win32', env: {},
    execPath: 'C:\\Program Files\\nodejs\\node.exe', exit: (code) => { exit = code } }
  vm.runInNewContext(source, { require: mockRequire, process, console: { error: () => {} } })
  return { child, process, invocation, dependency, exit: () => exit }
}

test('Windows launch bypasses the shell and preserves literal argument boundaries', () => {
  const forwarded = ['--profile=C:\\Music Files\\prefs', '--label=a&b|c>d', '--literal="quoted"', '--value=$(echo test)']
  for (const command of ['dev', 'preview']) {
    const result = launch(command, forwarded)
    assert.equal(result.invocation[0], result.process.execPath)
    assert.deepEqual(Array.from(result.invocation[1]), [join(dirname(result.dependency), 'bin', 'electron-vite.js'), command, '--', ...forwarded])
    assert.equal(result.invocation[2].shell, false)
    assert.equal(result.invocation[2].windowsHide, true)
    result.child.emit('close', 7)
    assert.equal(result.exit(), 7)
  }
})

test('spawn failure stays unsuccessful when the child closes without an exit code', () => {
  const result = launch('dev')
  result.child.emit('error', new Error('not found'))
  result.child.emit('close', null)
  assert.equal(result.exit(), 1)
})
