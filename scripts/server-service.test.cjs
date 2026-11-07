'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { once } = require('node:events')
const { createInterface } = require('node:readline')

const executable = resolve(__dirname, '../out/server-service/twilight-server-service.exe')
const fixture = String.raw`
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const root=process.argv.at(-1), mode=JSON.parse(fs.readFileSync(path.join(root,'fixture.json'),'utf8')).mode;
// Detached avoids Node's own child Job, so only the native host's Job owns this descendant.
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:true});
fs.writeFileSync(path.join(root,'pids.json'),JSON.stringify({root:process.pid,child:child.pid,args:process.argv.slice(2)}));
if(mode!=='startup-timeout')process.stdout.write('TWILIGHT_SERVER_READY\n');
if(mode==='root-crash')setTimeout(()=>process.exit(7),100);
let stops=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 if(line!=='TWILIGHT_SERVER_STOP')process.exit(9);
 if(mode==='stop-fails'&&++stops===1){process.stdout.write('TWILIGHT_SERVER_STOP_FAILED\n');return}
 if(mode==='shutdown-fails'){process.stdout.write('TWILIGHT_SERVER_STOP_FAILED\n');return}
 if(mode==='stop-timeout'||mode==='shutdown-timeout')return;
 if(mode==='orphan'){process.stdout.write('TWILIGHT_SERVER_STOPPED\n');process.exit(0)}
 child.once('exit',()=>{process.stdout.write('TWILIGHT_SERVER_STOPPED\n');process.stdin.destroy()});child.kill();
});
`

async function launch(t, mode, args = []) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-service-test-'))
  const data = join(root, '资料 with space')
  await mkdir(data)
  const entry = join(root, 'fixture with space.cjs')
  await writeFile(entry, fixture)
  await writeFile(join(data, 'fixture.json'), JSON.stringify({ mode }))
  const suppliedData = data + '\\'
  const process = spawn(
    executable,
    [
      '--console',
      '--node',
      global.process.execPath,
      '--entry',
      entry,
      '--data',
      suppliedData,
      ...args
    ],
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  let stderr = ''
  process.stderr.on('data', (data) => {
    stderr += data
  })
  const states = [],
    waiters = new Set()
  createInterface({ input: process.stdout }).on('line', (line) => {
    const match = /^STATE (\w+) error=(\d+) pid=(\d+)$/.exec(line)
    assert.ok(match, line)
    states.push({ state: match[1], error: Number(match[2]), pid: Number(match[3]) })
    for (const wake of waiters) wake()
  })
  const exit = once(process, 'close')
  let exited = false
  exit.then(() => {
    exited = true
    for (const wake of waiters) wake()
  })
  const waitState = (state, start = 0) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(Error(`No ${state}: ${JSON.stringify(states)} ${stderr}`))
      }, 10000)
      const cleanup = () => {
        clearTimeout(timer)
        waiters.delete(check)
      }
      const check = () => {
        const found = states.slice(start).find((row) => row.state === state)
        if (found) {
          cleanup()
          resolve(found)
        } else if (exited) {
          cleanup()
          reject(Error(`Exited before ${state}: ${JSON.stringify(states)} ${stderr}`))
        }
      }
      waiters.add(check)
      check()
    })
  t.after(async () => {
    if (process.exitCode === null && process.signalCode === null) {
      process.kill()
      await exit
    }
    assert.equal(resolve(root, '..'), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  return {
    process,
    states,
    waitState,
    exit,
    data,
    suppliedData,
    stderr: () => stderr,
    pids: async () => JSON.parse(await readFile(join(data, 'pids.json'), 'utf8'))
  }
}
const alive = (pid) => {
  try {
    global.process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
async function gone(...pids) {
  const deadline = Date.now() + 5000
  while (pids.some(alive) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(
    pids.every((pid) => !alive(pid)),
    `Owned processes still alive: ${pids}`
  )
}

test(
  'native host reports ready only after the child and confirms the whole owned Job exits on stop',
  { timeout: 15000 },
  async (t) => {
    const f = await launch(t, 'normal')
    const ready = await f.waitState('RUNNING'),
      pids = await f.pids()
    assert.equal(ready.pid, pids.root)
    assert.deepEqual(pids.args, ['service-child', '--data', f.suppliedData])
    f.process.stdin.write('stop\n')
    const stopped = await f.waitState('STOPPED')
    assert.equal(stopped.error, 0, f.stderr())
    assert.equal((await f.exit)[0], 0)
    await gone(pids.root, pids.child)
    assert.match(await readFile(join(f.data, 'server-service.log'), 'utf8'), /ownedRemaining=0/)
  }
)

test(
  'a failed stop remains RUNNING and permits an explicit later checkpoint attempt',
  { timeout: 15000 },
  async (t) => {
    const f = await launch(t, 'stop-fails')
    await f.waitState('RUNNING')
    const after = f.states.length
    f.process.stdin.write('stop\n')
    await f.waitState('STOP_PENDING', after)
    await f.waitState('RUNNING', after)
    assert.equal(f.process.exitCode, null)
    assert.ok(!f.states.some((row) => row.state === 'STOPPED'))
    f.process.stdin.write('stop\n')
    assert.equal((await f.waitState('STOPPED')).error, 0)
    await f.exit
    const pids = await f.pids()
    await gone(pids.root, pids.child)
  }
)

for (const mode of ['startup-timeout', 'root-crash', 'orphan', 'shutdown-fails']) {
  test(
    `native ${mode} never reports a successful stop and terminates only its owned processes`,
    { timeout: 15000 },
    async (t) => {
      const f = await launch(t, mode, ['--start-timeout-ms', '1000'])
      if (mode === 'orphan' || mode === 'shutdown-fails') {
        await f.waitState('RUNNING')
        f.process.stdin.write(mode === 'orphan' ? 'stop\n' : 'shutdown\n')
      }
      const stopped = await f.waitState('STOPPED')
      assert.notEqual(stopped.error, 0, f.stderr())
      assert.equal((await f.exit)[0], 1)
      if (mode === 'startup-timeout') assert.ok(!f.states.some((row) => row.state === 'RUNNING'))
      const pids = await f.pids()
      await gone(pids.root, pids.child)
    }
  )
}

test(
  'an unacknowledged ordinary stop returns RUNNING without killing the managed Core',
  { timeout: 15000 },
  async (t) => {
    const f = await launch(t, 'stop-timeout', ['--stop-timeout-ms', '300'])
    await f.waitState('RUNNING')
    const after = f.states.length
    f.process.stdin.write('stop\n')
    await f.waitState('STOP_PENDING', after)
    await f.waitState('RUNNING', after)
    const pids = await f.pids()
    assert.ok(alive(pids.root) && alive(pids.child))
    assert.ok(!f.states.some((row) => row.state === 'STOPPED'))
    f.process.kill()
    await f.exit
    await gone(pids.root, pids.child)
  }
)

test(
  'an OS shutdown deadline terminates the owned Job and reports failure rather than a successful checkpoint',
  { timeout: 15000 },
  async (t) => {
    const f = await launch(t, 'shutdown-timeout', ['--stop-timeout-ms', '300'])
    await f.waitState('RUNNING')
    f.process.stdin.write('shutdown\n')
    assert.notEqual((await f.waitState('STOPPED')).error, 0)
    assert.equal((await f.exit)[0], 1)
    const pids = await f.pids()
    await gone(pids.root, pids.child)
  }
)

test(
  'killing the native wrapper closes its kernel Job and cannot leave a background Core or DAC process',
  { timeout: 15000 },
  async (t) => {
    const f = await launch(t, 'normal')
    await f.waitState('RUNNING')
    const pids = await f.pids()
    f.process.kill()
    await f.exit
    await gone(pids.root, pids.child)
  }
)
