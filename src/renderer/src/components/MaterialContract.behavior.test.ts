import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { MATERIAL_ROLES, compileMaterialCss } from '../../../shared/materials.ts'
import { compileStyle, parse } from '@vue/compiler-sfc'

const require = createRequire(import.meta.url)
test('embedded equalizer preserves the workspace backdrop in both tones and modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-embedded-material-'))
  try {
    const page = parse(await readFile(new URL('./EqualizerPage.vue', import.meta.url), 'utf8'))
    const base = await readFile(new URL('../assets/base.css', import.meta.url), 'utf8')
    const css = page.descriptor.styles
      .map((style) => {
        const result = compileStyle({
          source: style.content,
          filename: 'EqualizerPage.vue',
          id: 'data-v-eq',
          scoped: true
        })
        assert.deepEqual(result.errors, [])
        return result.code
      })
      .join('\n')
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><style>${base}:root{--te-app-bg:#18191b;--te-app-bg-image:linear-gradient(red,black)}${css}</style>
      <div class="eq-page" data-v-eq><div class="eq-container" data-v-eq><main class="eq-content" data-v-eq></main></div></div></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',__dirname+'/profile');app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});
      try{await win.loadFile(__dirname+'/index.html');await win.webContents.executeJavaScript(\`(()=>{
        const root=document.querySelector('.eq-page'),container=root.firstElementChild,content=container.firstElementChild;
        for(const tone of ['dark','pureWhite'])for(const parametric of [false,true]){
          document.documentElement.dataset.theme=tone;root.classList.toggle('is-parametric',parametric);
          root.classList.add('is-embedded');
          for(const node of [root,container,content]){const style=getComputedStyle(node);if(style.backgroundColor!=='rgba(0, 0, 0, 0)'||style.backgroundImage!=='none')throw Error(tone+'/'+parametric+': embedded DSP repaints the reading backdrop')}
          root.classList.remove('is-embedded');if(getComputedStyle(root).backgroundImage==='none')throw Error('standalone DSP lost its background');
        }
      })()\`);console.log('EMBEDDED_MATERIAL_OK');app.exit(0)}catch(error){console.error(error);app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(require('electron'), [join(directory, 'runner.cjs')], {
      env,
      windowsHide: true,
      timeout: 30_000
    })
    assert.match(result.stdout, /EMBEDDED_MATERIAL_OK/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('material roles render across tones, modes and opaque fallbacks without changing geometry or input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-material-contract-'))
  try {
    const base = await readFile(new URL('../assets/base.css', import.meta.url), 'utf8')
    const bohr = await readFile(new URL('../assets/bohr.css', import.meta.url), 'utf8')
    const css = `${base}\n${compileMaterialCss()}\n${bohr}`
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><style>${css}
      body{margin:0}.te-material{width:240px;height:48px;padding:8px;border:1px solid;border-radius:12px;box-sizing:border-box;margin:4px}
      </style></head><body>${MATERIAL_ROLES.map((role) => `<button class="te-material" data-te-material="${role}">${role}</button>`).join('')}
      <script>
      window.runMaterialCases=async()=>{
        const check=(ok,message)=>{if(!ok)throw Error(message)};let cases=0;
        const opaqueRoles=['dialog','popover','panel','control'];
        for(const tone of ['pureWhite','dark'])for(const mode of ['standard','transparent','liquidGlass'])for(const fallback of ['normal','no-blur','reduced']){
          document.documentElement.dataset.theme=tone;document.documentElement.dataset.teSurfaceMaterial=mode;
          document.documentElement.dataset.teEffectsMode=fallback==='reduced'?'reduced':'full';
          document.body.classList.toggle('te-no-blur',fallback==='no-blur');
          for(const node of document.querySelectorAll('.te-material')){
            const role=node.dataset.teMaterial,style=getComputedStyle(node),rect=node.getBoundingClientRect();
            check(rect.width===240&&rect.height===48&&style.borderRadius==='12px','material changed component geometry');
            check(style.color!=='rgba(0, 0, 0, 0)'&&style.color!=='','material lost readable ink');
            if(fallback!=='normal'){
              check(style.backdropFilter==='none','fallback retained expensive diffusion');
              check(!style.backgroundColor.endsWith(', 0)'),'fallback lost its opaque surface');
            }else if(mode==='transparent'&&!opaqueRoles.includes(role)){
              check(style.backgroundColor==='rgba(0, 0, 0, 0)'&&style.backdropFilter==='none','transparent surface did not release paint');
            }else if(opaqueRoles.includes(role))check(style.backgroundColor!=='rgba(0, 0, 0, 0)','reading surface became transparent');
            let clicks=0;node.onclick=()=>clicks++;node.click();check(clicks===1,'material intercepted input');cases++;
          }
        }
        const panel=document.querySelector('[data-te-material="panel"]');
        document.body.classList.remove('te-no-blur');document.documentElement.dataset.teEffectsMode='full';document.documentElement.dataset.teSurfaceMaterial='standard';
        panel.style.setProperty('--te-chrome-material-solid','rgb(30, 60, 90)');
        check(getComputedStyle(panel).backgroundColor==='rgb(30, 60, 90)','local preview/theme overrides were resolved at root instead of the painter');
        // Editor-owned card settings still flow through the content recipe.
        const content=document.querySelector('[data-te-material="content"]');content.style.setProperty('--te-card-bg','rgb(90, 60, 30)');
        check(getComputedStyle(content).backgroundColor==='rgb(90, 60, 30)','card editor inputs were replaced by a separate material state');
        return {cases,localContext:true,editorInputs:true};
      };
      window.checkAccessibleMaterial=()=>{
        for(const mode of ['transparent','liquidGlass']){
          document.documentElement.dataset.teSurfaceMaterial=mode;
          for(const node of document.querySelectorAll('.te-material')){
            const style=getComputedStyle(node);
            if(style.backdropFilter!=='none'||style.backgroundColor==='rgba(0, 0, 0, 0)')throw Error('accessibility material fallback lost precedence: '+mode+'/'+node.dataset.teMaterial);
          }
        }
      };</script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');
      app.setPath('userData',require('node:path').join(__dirname,'profile'));
      app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:900,height:900,webPreferences:{offscreen:true,contextIsolation:false,backgroundThrottling:false}});
      try{await win.loadFile(process.argv.at(-1));const result=await win.webContents.executeJavaScript('window.runMaterialCases()');
      win.webContents.debugger.attach('1.3');
      for(const [name,value] of [['prefers-reduced-transparency','reduce'],['prefers-contrast','more'],['forced-colors','active']]){
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name,value}]});
        const failure=await win.webContents.executeJavaScript('(()=>{try{window.checkAccessibleMaterial();return null}catch(error){return error.message}})()');if(failure)throw Error(name+': '+failure);
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
      }
      console.error('MATERIAL_CONTRACT_OK '+JSON.stringify({...result,accessibilityCases:54}));app.exit(0)}catch(error){console.error(error);app.exit(1)}});`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const { stderr } = await promisify(execFile)(
      require('electron') as string,
      [join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { env, windowsHide: true, timeout: 60_000 }
    )
    assert.match(stderr, /MATERIAL_CONTRACT_OK/)
    assert.match(stderr, /"cases":162/)
    assert.match(stderr, /"accessibilityCases":54/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
