'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildReport } = require('./ipc-channel-report.cjs')

test('main registrations and preload invokes are fully mapped', () => {
  const report = buildReport()
  assert.ok(report.summary.mainHandles > 0, 'main IPC contract must exist')
  assert.ok(report.summary.preloadInvokes > 0, 'preload IPC contract must exist')
  assert.deepEqual(report.summary.preloadInvokeMissingMain, [])
})

test('ipcMain.on channels and preload event listeners are present for broadcast data flow', () => {
  const report = buildReport()
  assert.ok(report.summary.mainOn > 0, 'expected at least one ipcMain.on registration')
  assert.ok(
    report.summary.preloadEventListeners > 0,
    'expected at least one preload ipcRenderer.on listener'
  )
})

test('every renderer window.api domain maps to a declared preload domain', () => {
  const report = buildReport()
  assert.deepEqual(report.summary.rendererDomainsMissingPreload, [])
})

test('public IPC channel contracts match the committed baseline', () => {
  const baselinePath = path.join(
    __dirname,
    'fixtures',
    'ipc-channel-baseline.json'
  )
  const baselineSnapshot = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  const currentSnapshot = buildBaselineSnapshot(buildReport())
  assert.deepEqual(
    currentSnapshot,
    Object.fromEntries(Object.keys(currentSnapshot).map((key) => [key, baselineSnapshot[key]])),
    'Public IPC channels changed. Review the contract and regenerate its baseline.'
  )
})

test('renderer implementation footprints do not change the public IPC contract', () => {
  const report = buildReport()
  assert.deepEqual(
    buildBaselineSnapshot({ ...report, rendererApiUses: [], summary: {} }),
    buildBaselineSnapshot(report)
  )
})

function unique(values) {
  return [...new Set(values)].sort()
}

function buildBaselineSnapshot(report) {
  return {
    mainHandles: unique(report.mainHandles),
    mainOn: unique(report.mainOn),
    preloadInvokes: unique(report.preloadInvokes),
    preloadSends: unique(report.preloadSends),
    preloadEventListeners: unique(report.preloadEventListeners)
  }
}
