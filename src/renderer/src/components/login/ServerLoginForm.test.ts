import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'

test('server login submits credentials once, clears the password and blocks duplicate submission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'te-server-login-'))
  const require = createRequire(import.meta.url)
  try {
    const source = await readFile(new URL('./ServerLoginForm.vue', import.meta.url), 'utf8')
    const { descriptor } = parse(source)
    let script = ts.transpileModule(
      compileScript(descriptor, { id: 'server-login', inlineTemplate: true }).content,
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
      }
    ).outputText
    script = script
      .replace(
        /import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/g,
        (_match, names: string) =>
          `const { ${names.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2')} } = Vue;`
      )
      .replace('export default', 'const Form =')
    const vue = await readFile(require.resolve('vue/dist/vue.global.prod.js'), 'utf8')
    const html = join(directory, 'fixture.html')
    const runner = join(directory, 'runner.cjs')
    await writeFile(
      html,
      `<div id="app"></div><script>${vue}</script><script>${script}
      const busy = Vue.ref(false), calls = [];
      Vue.createApp({ render: () => Vue.h(Form, { busy: busy.value, error: '', onSubmit: (...args) => calls.push(args) }) }).mount('#app');
      window.check = async () => {
        const inputs = document.querySelectorAll('input');
        ['https://fixture.invalid/jellyfin', ' Listener ', 'fixture-password'].forEach((value, index) => {
          inputs[index].value = value; inputs[index].dispatchEvent(new Event('input'));
        });
        document.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
        await Vue.nextTick();
        if (JSON.stringify(calls) !== JSON.stringify([['https://fixture.invalid/jellyfin', 'Listener', 'fixture-password']])) throw Error('wrong credentials');
        if (inputs[2].value !== '') throw Error('password retained');
        busy.value = true; await Vue.nextTick();
        document.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
        if (calls.length !== 1 || !document.querySelector('button').disabled) throw Error('duplicate login');
        return true;
      };
    </script>`
    )
    await writeFile(
      runner,
      `const { app, BrowserWindow } = require('electron');
      app.whenReady().then(async () => { const win = new BrowserWindow({ show: false });
        try { await win.loadFile(process.argv.at(-1)); await win.webContents.executeJavaScript('window.check()'); console.error('SERVER_LOGIN_OK'); app.exit(0); }
        catch (error) { console.error(error); app.exit(1); }
      });`
    )
    const { stderr } = await promisify(execFile)(
      require('electron') as string,
      ['--no-sandbox', runner, html],
      { windowsHide: true, timeout: 30000 }
    )
    assert.match(stderr, /SERVER_LOGIN_OK/)
    const page = await readFile(new URL('../LoginPage.vue', import.meta.url), 'utf8')
    assert.match(page, /supportedMethods\?\.includes\('loginWithServer'\)/)
    assert.match(page, /v-if="supportsServerLogin"/)
    assert.match(page, /revision !== loginRevision \|\| activeProviderId\.value !== providerId/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
