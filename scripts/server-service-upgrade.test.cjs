'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { resolve } = require('node:path')

test('SCM upgrade adapter parses in PowerShell 7 without executing service or ACL operations', async () => {
  const result = await promisify(execFile)(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:TWILIGHT_TEST_SCRIPT,[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }; 'parsed'"
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        TWILIGHT_TEST_SCRIPT: resolve(__dirname, 'server-service-upgrade.ps1')
      }
    }
  )
  assert.equal(result.stdout.trim(), 'parsed')
})
