import '@fontsource-variable/inter-tight';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import './style.css';
import './responsive.css';
import { EchoSound } from './sound';
import { SoundField } from './sound-field';

gsap.registerPlugin(ScrollTrigger);

const arrow = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14" stroke="currentColor" stroke-width="1.5"/></svg>';
const down = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4v16m-7-7 7 7 7-7" stroke="currentColor" stroke-width="1.5"/></svg>';
const wave = '<svg viewBox="0 0 34 34" fill="none" aria-hidden="true"><path d="M3 17h3m5-7v14m6-22v30m6-22v14m5-7h3" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/></svg>';
const github = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .9A11.1 11.1 0 0 0 8.5 22.5c.55.1.75-.24.75-.53v-2.07c-3.1.67-3.76-1.32-3.76-1.32-.5-1.28-1.23-1.62-1.23-1.62-1-.69.08-.67.08-.67 1.1.08 1.69 1.14 1.69 1.14.98 1.68 2.58 1.19 3.21.91.1-.71.38-1.2.7-1.47-2.47-.28-5.07-1.24-5.07-5.5 0-1.21.44-2.2 1.14-2.97-.12-.28-.5-1.41.11-2.94 0 0 .93-.3 3.05 1.13A10.6 10.6 0 0 1 12 6.22c.94 0 1.88.13 2.76.37 2.12-1.44 3.05-1.13 3.05-1.13.61 1.53.23 2.66.11 2.94.71.77 1.14 1.76 1.14 2.97 0 4.27-2.6 5.21-5.08 5.49.4.35.75 1.02.75 2.06v3.05c0 .3.2.64.76.53A11.1 11.1 0 0 0 12 .9Z"/></svg>';
const repo = 'https://github.com/Px-asen/Twilight_Echo';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <a class="skip-link" href="#experience">跳到内容</a>
  <div class="reading-progress" aria-hidden="true"></div>
  <div class="cursor" aria-hidden="true"><span></span></div>
  <header class="header">
    <a class="brand" href="#top" aria-label="Twilight Echo 首页">${wave}<span>twilight<br>echo<span class="brand-period">✳</span></span></a>
    <nav class="desktop-nav" aria-label="主导航">
      <a class="nav-link" href="#experience">体验<span>01</span></a>
      <a class="nav-link" href="#afterglow">余晖<span>02</span></a>
      <a class="nav-link" href="#open-source">关于<span>03</span></a>
    </nav>
    <div class="header-actions">
      <button class="sound-switch" type="button" aria-pressed="false" aria-label="开启环境音">
        <span class="sound-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span class="sound-label">声音关闭</span>
      </button>
      <a class="header-download" href="#download">免费下载 ${arrow}</a>
      <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="mobile-nav" aria-label="打开导航"><span></span><span></span></button>
    </div>
  </header>
  <nav class="mobile-nav" id="mobile-nav" aria-label="移动导航" inert>
    <a href="#experience">体验 <small>01</small></a><a href="#afterglow">余晖 <small>02</small></a><a href="#open-source">关于 <small>03</small></a><a href="#download">免费下载 ${arrow}</a>
    <p>YOUR MUSIC. YOUR UNIVERSE.</p>
  </nav>
  <main>
    <section class="hero" id="top" aria-labelledby="hero-title">
      <div class="hero-meta mono"><span><i class="status-dot"></i> 一个有温度的开源音乐播放器</span><span>INDEPENDENT & OPEN &nbsp; / &nbsp; MADE FOR LISTENING</span></div>
      <h1 class="hero-title" id="hero-title"><span class="title-line title-twilight"><span>TWILIGHT</span></span><span class="title-line title-echo"><span>ECHO<span class="title-dot">.</span></span></span></h1>
      <div class="hero-orbit" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="orbit orbit-three"></div><span class="orbit-point"></span><span class="orbit-cross">+</span></div>
      <div class="hero-character" data-cursor="ECHO"><div class="character-drift"><img src="/assets/echo-character.webp" width="1200" height="1766" alt="Twilight Echo 看板娘，灰色长发、衬衫与宽松外套" fetchpriority="high" draggable="false"></div></div>
      <div class="character-caption mono" aria-hidden="true"><span>YOUR QUIET COMPANION</span><span>↗ &nbsp; ALWAYS HERE</span></div>
      <div class="hero-copy">
        <h2>把世界，<br>调小声。</h2>
        <p>从珍藏的那一首，到下一次心动。<br>让音乐回到你身边，让自己沉浸一点。</p>
        <div class="hero-cta"><a class="button button-dark magnetic" href="#download"><span>遇见 Twilight Echo</span>${arrow}</a><a class="explore-link" href="#experience">往下，听见更多 <span>${down}</span></a></div>
      </div>
      <div class="hero-bottom mono"><span>LOCAL. STREAMING. ABSOLUTELY YOURS.</span><span class="scroll-hint"><span class="scroll-line"></span> SCROLL TO FEEL</span><span>01 — 05</span></div>
    </section>

    <div class="ticker" aria-hidden="true"><div class="ticker-track">${Array.from({ length: 4 }, () => `<span>LESS NOISE</span><span class="ticker-star">✳</span><span class="ticker-outline">MORE MUSIC</span><span class="ticker-star">✳</span>`).join('')}</div></div>

    <section class="experience section-pad" id="experience" aria-labelledby="experience-title">
      <div class="section-heading"><span class="eyebrow mono"><i></i> 01 / THE EXPERIENCE</span><span class="side-note mono">DESIGNED AROUND YOUR MUSIC</span></div>
      <div class="experience-heading"><h2 id="experience-title" class="reveal">你的音乐，<br><span class="muted">自成宇宙。</span></h2><div class="experience-intro reveal"><span class="asterisk" aria-hidden="true">✳</span><p>不必在本地收藏和在线发现之间选择。<br>把喜欢的声音，放在同一个地方。</p></div></div>
      <div class="showcase reveal">
        <div class="showcase-top"><div class="window-dots" aria-hidden="true"><i></i><i></i><i></i></div><span class="mono">TWILIGHT ECHO / IN FOCUS</span><span class="preview-state mono">01 — LIBRARY</span></div>
        <div class="preview-screen" role="tabpanel" id="product-panel" aria-labelledby="tab-library" tabindex="0">
          <img class="product-image is-active" data-image="library" src="/assets/library.webp" alt="Twilight Echo 本地曲库实景：专辑封面、歌曲与艺术家列表" width="1800" height="1050" loading="lazy">
          <img class="product-image" data-image="lyrics" src="/assets/lyrics.webp" alt="Twilight Echo 沉浸歌词实景：专辑封面与大字同步歌词" width="1800" height="1050" loading="lazy" aria-hidden="true">
          <img class="product-image" data-image="sound" src="/assets/sound.webp" alt="Twilight Echo 参数均衡器实景：频响曲线与调音控制" width="1800" height="1050" loading="lazy" aria-hidden="true">
          <img class="product-image" data-image="home" src="/assets/home.webp" alt="Twilight Echo 主页实景：唱片式播放视图与每日推荐" width="1800" height="1050" loading="lazy" aria-hidden="true">
        </div>
        <div class="preview-bottom mono"><span><i class="status-dot"></i> 真实界面 · 随心切换</span><span class="preview-counter">01 / 04</span><span>BUILT FOR THE WAY YOU LISTEN</span></div>
      </div>
      <div class="feature-tabs" role="tablist" aria-label="探索播放器界面">
        <button class="feature-tab is-active" role="tab" id="tab-library" data-tab="library" aria-selected="true" aria-controls="product-panel"><span class="tab-number mono">01</span><span class="tab-content"><strong>收藏，各归其位。</strong><span>本地曲库 / 专辑与艺术家 / 元数据整理</span></span><span class="tab-arrow">↗</span></button>
        <button class="feature-tab" role="tab" id="tab-lyrics" data-tab="lyrics" aria-selected="false" aria-controls="product-panel" tabindex="-1"><span class="tab-number mono">02</span><span class="tab-content"><strong>每一句，都有回响。</strong><span>沉浸歌词 / 逐词同步 / 桌面歌词</span></span><span class="tab-arrow">↗</span></button>
        <button class="feature-tab" role="tab" id="tab-sound" data-tab="sound" aria-selected="false" aria-controls="product-panel" tabindex="-1"><span class="tab-number mono">03</span><span class="tab-content"><strong>好声音，不止一种。</strong><span>原生音频引擎 / 参数均衡 / 耳机校正</span></span><span class="tab-arrow">↗</span></button>
        <button class="feature-tab" role="tab" id="tab-home" data-tab="home" aria-selected="false" aria-controls="product-panel" tabindex="-1"><span class="tab-number mono">04</span><span class="tab-content"><strong>下一首，又是心动。</strong><span>在线发现 / 统一搜索 / 可选音源扩展</span></span><span class="tab-arrow">↗</span></button>
      </div>
    </section>

    <section class="afterglow" id="afterglow" aria-labelledby="afterglow-title">
      <div class="afterglow-top section-pad"><span class="eyebrow mono"><i></i> 02 / AFTERGLOW MODE</span><span class="mono afterglow-status"><i class="status-dot"></i> <span>INTERFACE ACTIVE</span></span></div>
      <div class="afterglow-stage">
        <canvas class="sound-field" aria-hidden="true"></canvas>
        <div class="afterglow-orb" aria-hidden="true"><div class="orb-ring"></div><div class="orb-ring"></div><div class="orb-ring"></div><div class="orb-core">${wave}</div></div>
        <div class="afterglow-title-wrap"><span class="afterglow-whisper mono">SOME THINGS SOUND BETTER IN THE DARK.</span><h2 id="afterglow-title"><span class="glow-line">LIGHTS <span class="outline-text">OFF.</span></span><span class="glow-line">MUSIC <span class="serif-word">ON.</span></span></h2></div>
        <div class="afterglow-message" aria-live="polite"><span class="mono">YOU DISAPPEAR. THE MUSIC DOESN’T.</span><strong>世界安静了。<br>音乐，还在。</strong><span class="afterglow-playing mono"><i></i> ECHO IS STILL HERE</span></div>
      </div>
      <div class="afterglow-bottom section-pad"><div><span class="mini-label mono">少一点打扰，多一点音乐。</span><p>余晖模式卸下界面的负担，原生引擎继续播放。<br>需要的时候，托盘或快捷键让一切回到眼前。</p></div><button class="afterglow-toggle" type="button" aria-pressed="false"><span class="toggle-orbit" aria-hidden="true"><i></i></span><span class="afterglow-button-label">感受一下余晖</span>${arrow}</button></div>
    </section>

    <section class="details section-pad" id="open-source" aria-labelledby="details-title">
      <div class="section-heading"><span class="eyebrow mono"><i></i> 03 / MADE TO BE YOURS</span><span class="side-note mono">NO TWO LISTENERS ARE THE SAME.</span></div>
      <div class="details-grid"><div class="details-intro"><h2 id="details-title" class="reveal">不设限。<br><span class="muted">也不设围墙。</span></h2><p class="reveal">好用的播放器，应该听你的。<br>从声音到外观，从你的硬盘到更远的地方。</p><a class="text-link" href="${repo}" target="_blank" rel="noopener noreferrer">在 GitHub，和我们一起创造 ${arrow}</a><div class="open-seal mono"><span>${github}</span>OPEN SOURCE<br>APACHE 2.0</div></div>
      <div class="detail-list">
        <article class="detail-row reveal"><span class="mono">01 / SOUND</span><div><h3>让两首喜欢，自然相遇。</h3><p>无缝播放、交叉淡化与 Twilight AutoMix。<br>从这一首，到下一首，情绪不必被打断。</p></div><span class="detail-symbol" aria-hidden="true">∞</span></article>
        <article class="detail-row reveal"><span class="mono">02 / PERSONAL</span><div><h3>有你的风格，才是你的播放器。</h3><p>深浅主题、封面取色与自定义背景。<br>用主题工作室，调成喜欢的样子。</p></div><span class="detail-symbol" aria-hidden="true">◐</span></article>
        <article class="detail-row reveal"><span class="mono">03 / CONNECT</span><div><h3>音乐在哪里，就听到哪里。</h3><p>连接 WebDAV 等网络音乐源。<br>用音源、主题和工具扩展，打开更多可能。</p></div><span class="detail-symbol" aria-hidden="true">↗</span></article>
      </div></div>
      <div class="faq"><span class="mono faq-label">BEFORE YOU PRESS PLAY / 播放之前</span><div class="faq-items">
        <details><summary>听本地音乐，需要登录吗？<span aria-hidden="true">+</span></summary><p>不需要。添加音乐文件夹，就可以播放已有的本地音乐。在线推荐、网络音源与在线歌词需要联网；部分在线内容需要对应平台的账号或订阅。</p></details>
        <details><summary>现在支持哪些平台？<span aria-hidden="true">+</span></summary><p>Windows 10 / 11 是当前主要且验证最完整的平台。发布页也提供 macOS 与 Linux 安装包，这两个平台仍在完善和验证中。</p></details>
        <details><summary>我的无损收藏，可以直接播放吗？<span aria-hidden="true">+</span></summary><p>支持 FLAC、WAV、ALAC、APE、WavPack，以及 DSF、DFF、SACD ISO 和 CUE 整轨分曲等格式。实际解码与输出能力取决于发布包、驱动和音频设备。</p></details>
      </div></div>
    </section>

    <section class="download section-pad" id="download" aria-labelledby="download-title"><div class="section-heading"><span class="eyebrow mono"><i></i> 04 / YOUR NEXT FAVORITE PLAYER</span><span class="mono">FREE & OPEN SOURCE. ALWAYS.</span></div><div class="download-main"><div><p class="download-kicker reveal">戴上耳机。剩下的，交给音乐。</p><h2 id="download-title"><span>LET IT</span><span class="download-echo">ECHO<span class="download-period">.</span></span></h2></div><a class="download-disc magnetic" href="${repo}/releases/latest" target="_blank" rel="noopener noreferrer" aria-label="在 GitHub Releases 下载 Twilight Echo"><span class="disc-groove" aria-hidden="true"></span><span class="disc-label">${down}<strong>免费下载</strong><span class="mono">FOR WINDOWS</span></span><svg class="disc-edge mono" viewBox="0 0 320 320" aria-hidden="true"><defs><path id="disc-text-path" d="M160,160m-145,0a145,145 0 1,1 290,0a145,145 0 1,1 -290,0"/></defs><text><textPath href="#disc-text-path" textLength="910">YOUR MUSIC · YOUR UNIVERSE · TWILIGHT ECHO · YOUR MUSIC · YOUR UNIVERSE · TWILIGHT ECHO · </textPath></text></svg></a></div><div class="download-platforms"><span><i class="status-dot"></i> Windows 10 / 11</span><a href="${repo}/releases/latest" target="_blank" rel="noopener noreferrer">macOS / Linux <span>开发验证中 ${arrow}</span></a><a href="${repo}/releases" target="_blank" rel="noopener noreferrer">所有版本 ${arrow}</a></div></section>
  </main>
  <footer class="footer section-pad"><a class="brand footer-brand" href="#top" aria-label="回到顶部">${wave}<span>twilight<br>echo</span></a><p>在暮色里，听见自己的回声。</p><div class="footer-links"><a href="${repo}" target="_blank" rel="noopener noreferrer">GitHub ${arrow}</a><a href="${repo}/issues" target="_blank" rel="noopener noreferrer">反馈 ${arrow}</a><a href="${repo}/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">Apache 2.0 ${arrow}</a></div><div class="footer-bottom mono"><span>© ${new Date().getFullYear()} TWILIGHT ECHO</span><span>CRAFTED WITH CARE. PLAYED WITH LOVE.</span><button class="back-to-top" type="button">BACK TO TOP ↑</button></div></footer>
  <div class="sound-notice" role="status" aria-live="polite"></div>
`;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const sound = new EchoSound();
const field = new SoundField(document.querySelector<HTMLCanvasElement>('.sound-field')!, reducedMotion);

// Direct UI responses stay short; the editorial title gets a slower, one-time reveal.
const motion = gsap.matchMedia();
motion.add('(prefers-reduced-motion: no-preference)', () => {
  const intro = gsap.timeline({ defaults: { ease: 'power3.out' } });
  intro.from('.title-line > span', { yPercent: 112, duration: 1.25, stagger: 0.11, delay: 0.08 })
    .from('.hero-character', { y: 70, opacity: 0, duration: 1.25 }, 0.25)
    .from('.hero-orbit', { scale: 0.88, opacity: 0, duration: 1.4 }, 0.2)
    .from('.hero-copy > *, .hero-meta, .character-caption, .hero-bottom', { y: 18, opacity: 0, duration: 0.75, stagger: 0.06 }, 0.6);

  gsap.utils.toArray<HTMLElement>('.reveal').forEach((element) => {
    gsap.from(element, { y: 38, opacity: 0, duration: 0.85, ease: 'power3.out', scrollTrigger: { trigger: element, start: 'top 92%', once: true } });
  });

  const heroParallax = gsap.timeline({ scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: 0.8 } });
  heroParallax.to('.hero-title', { y: 90, ease: 'none' }, 0)
    .to('.hero-character', { y: 130, ease: 'none' }, 0)
    .to('.hero-orbit', { y: -65, rotation: 18, ease: 'none' }, 0);

  gsap.from('.showcase', { scale: 0.965, ease: 'none', scrollTrigger: { trigger: '.showcase', start: 'top 95%', end: 'top 30%', scrub: 0.8 } });
  gsap.from('.glow-line', { yPercent: 45, opacity: 0, stagger: 0.12, duration: 1.1, ease: 'power3.out', scrollTrigger: { trigger: '.afterglow', start: 'top 65%', once: true } });
  gsap.from('.download-main h2', { y: 65, opacity: 0, duration: 1, ease: 'power3.out', scrollTrigger: { trigger: '.download', start: 'top 70%', once: true } });
  return () => field.drawStatic();
});

const progress = document.querySelector<HTMLElement>('.reading-progress')!;
let scrollScheduled = false;
const updateScroll = () => {
  const range = document.documentElement.scrollHeight - window.innerHeight;
  progress.style.transform = `scaleX(${range > 0 ? window.scrollY / range : 0})`;
  document.body.classList.toggle('has-scrolled', window.scrollY > 45);
  scrollScheduled = false;
};
window.addEventListener('scroll', () => {
  if (!scrollScheduled) { scrollScheduled = true; requestAnimationFrame(updateScroll); }
}, { passive: true });
window.addEventListener('resize', updateScroll, { passive: true });
updateScroll();

// A real, keyboard-operable image switcher, not decorative tabs.
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.feature-tab')];
function selectTab(tab: HTMLButtonElement, focus = false) {
  tabs.forEach((button) => {
    const active = button === tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll<HTMLElement>('.product-image').forEach((image) => {
    const active = image.dataset.image === tab.dataset.tab;
    image.classList.toggle('is-active', active);
    image.setAttribute('aria-hidden', String(!active));
  });
  document.querySelector('#product-panel')!.setAttribute('aria-labelledby', tab.id);
  const number = String(tabs.indexOf(tab) + 1).padStart(2, '0');
  document.querySelector('.preview-state')!.textContent = `${number} — ${tab.dataset.tab!.toUpperCase()}`;
  document.querySelector('.preview-counter')!.textContent = `${number} / 04`;
  if (focus) tab.focus();
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    let next: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectTab(tabs[next], true); }
  });
});

const afterglow = document.querySelector<HTMLElement>('.afterglow')!;
const afterglowButton = document.querySelector<HTMLButtonElement>('.afterglow-toggle')!;
afterglowButton.addEventListener('click', () => {
  const active = afterglowButton.getAttribute('aria-pressed') !== 'true';
  afterglowButton.setAttribute('aria-pressed', String(active));
  afterglow.classList.toggle('is-resting', active);
  document.querySelector('.afterglow-button-label')!.textContent = active ? '让界面回来' : '感受一下余晖';
  document.querySelector('.afterglow-status > span')!.textContent = active ? 'INTERFACE OFF / MUSIC ON' : 'INTERFACE ACTIVE';
  field.setResting(active);
});

const soundButton = document.querySelector<HTMLButtonElement>('.sound-switch')!;
const soundNotice = document.querySelector<HTMLElement>('.sound-notice')!;
let noticeTimer = 0;
function notify(message: string) {
  soundNotice.textContent = message;
  soundNotice.classList.add('is-visible');
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => soundNotice.classList.remove('is-visible'), 4200);
}
soundButton.addEventListener('click', async () => {
  if (soundButton.disabled) return;
  soundButton.disabled = true;
  try {
    const active = await sound.toggle();
    soundButton.setAttribute('aria-pressed', String(active));
    soundButton.setAttribute('aria-label', active ? '关闭环境音' : '开启环境音');
    document.querySelector('.sound-label')!.textContent = active ? '声音开启' : '声音关闭';
    document.body.classList.toggle('sound-on', active);
    notify(active ? '原创合成环境音已开启 · 轻一点，听回声。' : '环境音已关闭。');
  } catch {
    notify('暂时无法开启环境音，请检查浏览器声音权限后重试。');
  } finally { soundButton.disabled = false; }
});

const menuButton = document.querySelector<HTMLButtonElement>('.menu-toggle')!;
const mobileNav = document.querySelector<HTMLElement>('.mobile-nav')!;
function closeMenu() {
  document.body.classList.remove('menu-open');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', '打开导航');
  mobileNav.inert = true;
}
menuButton.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true';
  document.body.classList.toggle('menu-open', open);
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? '关闭导航' : '打开导航');
  mobileNav.inert = !open;
  if (open) mobileNav.querySelector<HTMLAnchorElement>('a')!.focus();
});
mobileNav.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('menu-open')) { closeMenu(); menuButton.focus(); }
  if (event.key === 'Tab' && document.body.classList.contains('menu-open')) {
    const links = [...mobileNav.querySelectorAll<HTMLAnchorElement>('a')];
    if (event.shiftKey && document.activeElement === links[0]) { event.preventDefault(); menuButton.focus(); }
    else if (event.shiftKey && document.activeElement === menuButton) { event.preventDefault(); links.at(-1)!.focus(); }
    else if (!event.shiftKey && document.activeElement === links.at(-1)) { event.preventDefault(); menuButton.focus(); }
    else if (!event.shiftKey && document.activeElement === menuButton) { event.preventDefault(); links[0].focus(); }
  }
});
window.matchMedia('(min-width: 761px)').addEventListener('change', (event) => { if (event.matches) closeMenu(); });
document.querySelector('.back-to-top')!.addEventListener('click', () => window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'instant' : 'smooth' }));

// Pointer effects are restrained and disabled for touch and reduced motion.
motion.add('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)', () => {
  const cursor = document.querySelector<HTMLElement>('.cursor')!;
  const cursorLabel = cursor.querySelector<HTMLElement>('span')!;
  const toX = gsap.quickTo(cursor, 'x', { duration: 0.18, ease: 'power3.out' });
  const toY = gsap.quickTo(cursor, 'y', { duration: 0.18, ease: 'power3.out' });
  const character = document.querySelector<HTMLElement>('.character-drift')!;
  const characterX = gsap.quickTo(character, 'x', { duration: 0.85, ease: 'power3.out' });
  const characterY = gsap.quickTo(character, 'y', { duration: 0.85, ease: 'power3.out' });
  const onMove = (event: PointerEvent) => {
    toX(event.clientX); toY(event.clientY);
    cursor.classList.add('is-present');
    const target = (event.target as HTMLElement).closest<HTMLElement>('a, button, summary, [data-cursor]');
    cursor.classList.toggle('is-link', Boolean(target));
    cursor.classList.toggle('is-label', Boolean(target?.dataset.cursor));
    cursorLabel.textContent = target?.dataset.cursor ?? '';
    if (window.scrollY < window.innerHeight) {
      characterX((event.clientX / window.innerWidth - 0.5) * 18);
      characterY((event.clientY / window.innerHeight - 0.5) * 10);
    }
  };
  const onLeave = () => cursor.classList.remove('is-present');
  window.addEventListener('pointermove', onMove, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  const cleanups: (() => void)[] = [];
  document.querySelectorAll<HTMLElement>('.magnetic').forEach((element) => {
    const x = gsap.quickTo(element, 'x', { duration: 0.28, ease: 'power3.out' });
    const y = gsap.quickTo(element, 'y', { duration: 0.28, ease: 'power3.out' });
    const move = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      x((event.clientX - box.left - box.width / 2) * 0.1);
      y((event.clientY - box.top - box.height / 2) * 0.13);
    };
    const leave = () => { x(0); y(0); };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerleave', leave);
    cleanups.push(() => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerleave', leave); });
  });
  return () => { window.removeEventListener('pointermove', onMove); document.documentElement.removeEventListener('pointerleave', onLeave); cursor.classList.remove('is-present'); cleanups.forEach((cleanup) => cleanup()); };
});

// Pause ambient animation and the audio context when this preview is not visible.
document.addEventListener('visibilitychange', () => sound.setPageVisible(!document.hidden));
window.addEventListener('pagehide', () => { sound.dispose(); field.dispose(); });
window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
document.fonts.ready.then(() => ScrollTrigger.refresh());
if (!finePointer.matches) document.body.classList.add('touch-device');
