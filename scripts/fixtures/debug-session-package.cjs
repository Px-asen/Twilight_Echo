// Injected before the packaged main entry executes. Only the test profile is changed.
module.exports = function armDebugAcceptance({ root, phase }) {
  const require = process.getBuiltinModule('node:module').createRequire(process.execPath)
  const { app, BrowserWindow, dialog, utilityProcess, crashReporter } = require('electron')
  const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict')
  app.setPath('userData', path.join(root, 'profile'))
  app.setPath('logs', path.join(root, 'logs'))
  process.env.TWILIGHT_LOG_DIRECTORY = path.join(root, 'logs', 'diagnostics')
  app.disableHardwareAcceleration()
  // Inspector arguments are for this launcher, not its log writer worker.
  const threads = require('node:worker_threads'),
    Worker = threads.Worker
  threads.Worker = class extends Worker {
    constructor(entry, options) {
      super(entry, { ...options, execArgv: [] })
    }
  }
  BrowserWindow.prototype.show = function () {
    // Keep the acceptance window hidden while the runner drives it.
  }
  BrowserWindow.prototype.showInactive = function () {
    // Keep the acceptance window hidden without changing its focus.
  }
  // The outer runner starts each restart phase and checks its exit code.
  app.relaunch = () => {}
  dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  dialog.showSaveDialog = async () => ({
    canceled: false,
    filePath: path.join(root, phase === 'capture' ? 'capture.zip' : 'ordinary.zip')
  })
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  setTimeout(async () => {
    try {
      let window
      for (let i = 0; i < 200; i++) {
        window = BrowserWindow.getAllWindows().find(
          (w) => !w.isDestroyed() && w.webContents.getURL().includes('index.html')
        )
        if (window) {
          try {
            if (await window.webContents.executeJavaScript('Boolean(window.api?.diagnostics)'))
              break
          } catch {}
        }
        await delay(100)
      }
      assert.ok(window)
      const api = (expression) => window.webContents.executeJavaScript(expression)
      if (phase === 'ordinary') {
        const session = await api('window.api.diagnostics.startDebug({captureCrashes:false})')
        assert.equal(session.state, 'active')
        await delay(3500)
        const status = await api('window.api.diagnostics.getStatus()')
        assert.ok(
          status.debug.processes.some(
            (p) =>
              p.role === 'twilight-core' &&
              p.debugSessionId === session.id &&
              p.captureState === 'active'
          )
        )
        await api('window.api.diagnostics.markProblem("packaged debug reproduction")')
        const result = await api(
          `window.api.diagnostics.exportBundle({debugSessionId:${JSON.stringify(session.id)},stopDebug:true})`
        )
        assert.ok(fs.existsSync(result.filePath))
        fs.writeFileSync(path.join(root, 'ordinary-status.json'), JSON.stringify(status, null, 2))
        await api('window.api.diagnostics.startDebug({captureCrashes:true})')
      } else if (phase === 'capture') {
        assert.equal(crashReporter.getUploadToServer(), false)
        const status = await api('window.api.diagnostics.getStatus()')
        assert.equal(status.debug.state, 'active')
        assert.equal(status.debug.crashes.electron, 'active')
        assert.equal(status.debug.captureCrashes, true)
        fs.writeFileSync(path.join(root, 'capture-status.json'), JSON.stringify(status, null, 2))
        const worker = path.join(root, 'crash.cjs')
        fs.writeFileSync(worker, 'setTimeout(()=>process.crash(),100)')
        const child = utilityProcess.fork(worker, [], {
          serviceName: 'diagnostics-crash-fixture',
          stdio: 'pipe'
        })
        await new Promise((resolve) => child.once('exit', resolve))
        await delay(500)
        const result = await api(
          `window.api.diagnostics.exportBundle({debugSessionId:${JSON.stringify(status.debug.id)},includeCrashes:true,stopDebug:true})`
        )
        assert.equal(result.restarting, true)
      } else {
        for (let i = 0; i < 200; i++) {
          const status = await api('window.api.diagnostics.getStatus()')
          if (status.debug.pendingExport?.error) throw Error(status.debug.pendingExport.error)
          if (fs.existsSync(path.join(root, 'capture.zip')) && !status.debug.pendingExport) break
          await delay(100)
        }
        assert.ok(fs.existsSync(path.join(root, 'capture.zip')))
        const status = await api('window.api.diagnostics.getStatus()')
        assert.equal(status.debug.state, 'ended')
        assert.equal(status.debug.crashes.electron, 'stopped')
        assert.equal(status.debug.pendingExport, undefined)
        const previous = JSON.parse(fs.readFileSync(path.join(root, 'capture-status.json'), 'utf8'))
        assert.equal(status.debug.id, previous.debug.id)
        fs.writeFileSync(path.join(root, 'final-status.json'), JSON.stringify(status, null, 2))
        app.quit()
      }
    } catch (error) {
      fs.writeFileSync(path.join(root, `failure-${phase}.txt`), error.stack)
      app.exit(1)
    }
  }, 1500)
  return 'debug acceptance armed'
}
