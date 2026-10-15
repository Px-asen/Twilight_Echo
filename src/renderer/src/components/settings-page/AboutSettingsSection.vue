<script setup lang="ts">
import { ref } from 'vue'
import { useEscapeToClose, useFocusTrap } from '../../app/useDismissLayer.ts'
import { GITHUB_URL, HOMEPAGE_URL, RELEASES_URL } from './types.ts'
import AppUpdatePanel from './AppUpdatePanel.vue'

const AFDIAN_URL = 'https://ifdian.net/a/pxasen'
// Public assets are copied to the renderer root at build time. Relative paths
// resolve against the loaded document in both dev (http) and packaged builds
// (file://), where a leading "/" would point at the filesystem root.
const ALIPAY_QR_URL = './sponsor/alipay.jpg'
const WECHAT_QR_URL = './sponsor/wechat.png'
const QQ_GROUP_QR_URL = './qq-group-qrcode.jpg'

interface Sponsor {
  id: string
  name: string
}

const SPONSORS: readonly Sponsor[] = [
  {
    id: 'anbaichi',
    name: 'AnBaichi'
  },
  {
    id: 'meng-hui-fan-hua',
    name: '梦回繁华'
  },
  {
    id: 'when-we-talk-about-question-mark',
    name: '我们谈论问号时到底在谈论什么'
  },
  {
    id: 'noro',
    name: 'Noro'
  },
  {
    id: 'celestique',
    name: 'Celestique'
  },
  {
    id: 'afdian-user-b3f86',
    name: '爱发电用户_b3f86'
  },
  {
    id: 'jiang-feng-jiang1021',
    name: '江枫Jiang1021'
  },
  {
    id: 'your-rain',
    name: 'YourRain'
  },
  {
    id: 'afdian-user-fa664',
    name: '剑锋'
  },
  {
    id: 'yunshan',
    name: '云杉'
  },
  {
    id: 'yu',
    name: '羽'
  },
  {
    id: 'mumu-hina',
    name: 'MuMuHina'
  },
  {
    id: 'yjo',
    name: 'YJO'
  },
  {
    id: 'basement-little-evil-cow',
    name: '地下室的小邪牛本人'
  },
  {
    id: 'afdian-user-3adb7',
    name: '爱发电用户_3adb7'
  }
]

defineProps<{ appVersion: string }>()
const emit = defineEmits<{ exportAudioDiagnostics: [] }>()

function openExternal(url: string): void {
  void window.api?.shell?.openExternal?.(url)
}

function openGithub(): void {
  openExternal(GITHUB_URL)
}

function openHomepage(): void {
  openExternal(HOMEPAGE_URL)
}

function openChangelog(): void {
  openExternal(RELEASES_URL)
}

const sponsorDialogOpen = ref(false)
const sponsorDialogRef = ref<HTMLElement | null>(null)
const sponsorListOpen = ref(false)
const sponsorListRef = ref<HTMLElement | null>(null)
const qqGroupDialogOpen = ref(false)
const qqGroupDialogRef = ref<HTMLElement | null>(null)

function openSponsorDialog(): void {
  sponsorListOpen.value = false
  sponsorDialogOpen.value = true
}

function closeSponsorDialog(): void {
  sponsorDialogOpen.value = false
}

function openSponsorList(): void {
  sponsorDialogOpen.value = false
  sponsorListOpen.value = true
}

function closeSponsorList(): void {
  sponsorListOpen.value = false
}

function openQqGroupDialog(): void {
  qqGroupDialogOpen.value = true
}

function closeQqGroupDialog(): void {
  qqGroupDialogOpen.value = false
}

function openAfdian(): void {
  openExternal(AFDIAN_URL)
}

useEscapeToClose(sponsorDialogOpen, closeSponsorDialog)
useFocusTrap(sponsorDialogRef, sponsorDialogOpen)
useEscapeToClose(sponsorListOpen, closeSponsorList)
useFocusTrap(sponsorListRef, sponsorListOpen)
useEscapeToClose(qqGroupDialogOpen, closeQqGroupDialog)
useFocusTrap(qqGroupDialogRef, qqGroupDialogOpen)
</script>

<template>
  <section id="about" class="settings-section preview-section about-section">
    <div class="section-title-row">
      <i class="pi pi-info-circle" aria-hidden="true"></i>
      <h2>版本与关于</h2>
    </div>

    <div data-setting-id="app-version" id="setting-app-version" class="about-hero">
      <div class="logo-shell">
        <div class="logo-mark">
          <img src="/icon.png" alt="Twilight Echo" class="logo-icon" />
        </div>
      </div>
      <div class="about-copy">
        <h3>Twilight Echo</h3>
        <span>Version {{ appVersion || '—' }}</span>
      </div>
    </div>

    <div class="about-cards">
      <AppUpdatePanel />

      <div data-setting-id="project-support" id="setting-project-support" class="sponsor-card">
        <i class="pi pi-heart-fill sponsor-watermark" aria-hidden="true"></i>
        <div>
          <h3><i class="pi pi-heart"></i> 支持项目发展</h3>
          <p>赞助用于软件维护、功能开发与发布服务。</p>
        </div>
        <div class="sponsor-card-actions">
          <button class="sponsor-primary-button" type="button" @click="openSponsorDialog">
            <i class="pi pi-heart-fill"></i>
            赞助作者
          </button>
          <button class="sponsor-secondary-button" type="button" @click="openSponsorList">
            <i class="pi pi-users"></i>
            赞助名单
          </button>
        </div>
      </div>
    </div>

    <hr />

    <div data-setting-id="project-links" id="setting-project-links" class="about-links">
      <button type="button" @click="emit('exportAudioDiagnostics')">
        <i class="pi pi-file-export"></i> 导出音频诊断
      </button>
      <button type="button" @click="openGithub"><i class="pi pi-github"></i> GitHub</button>
      <button type="button" @click="openChangelog"><i class="pi pi-file-o"></i> 更新日志</button>
      <button type="button" @click="openHomepage"><i class="pi pi-heart-fill"></i> 开源致谢</button>
      <button type="button" @click="openQqGroupDialog"><i class="pi pi-comments"></i> Q群</button>
    </div>

    <Teleport to="body">
      <Transition name="sponsor-dialog">
        <div
          v-if="sponsorDialogOpen"
          class="sponsor-dialog-overlay"
          @click.self="closeSponsorDialog"
        >
          <section
            ref="sponsorDialogRef"
            class="sponsor-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sponsor-dialog-title"
          >
            <header class="sponsor-dialog-header">
              <div class="sponsor-dialog-title-copy">
                <span class="sponsor-dialog-icon"><i class="pi pi-heart-fill"></i></span>
                <div>
                  <h3 id="sponsor-dialog-title">赞助作者</h3>
                </div>
              </div>
              <button
                type="button"
                class="sponsor-dialog-close"
                aria-label="关闭赞助窗口"
                @click="closeSponsorDialog"
              >
                <i class="pi pi-times"></i>
              </button>
            </header>

            <div class="sponsor-dialog-notice" role="note">
              <i class="pi pi-info-circle"></i>
              <p>如需加入赞助名单，请联系作者。</p>
            </div>

            <button class="afdian-option" type="button" @click="openAfdian">
              <span class="afdian-option-icon"><i class="pi pi-external-link"></i></span>
              <span class="afdian-option-copy">
                <strong>前往爱发电</strong>
                <small>通过爱发电平台支持作者</small>
              </span>
              <i class="pi pi-angle-right"></i>
            </button>

            <div class="sponsor-qr-grid">
              <figure class="sponsor-qr-card alipay">
                <figcaption>
                  <span><i class="pi pi-wallet"></i></span>
                  <div>
                    <strong>支付宝</strong>
                    <small>打开支付宝扫一扫</small>
                  </div>
                </figcaption>
                <div class="sponsor-qr-image-shell">
                  <img :src="ALIPAY_QR_URL" alt="支付宝收款二维码" />
                </div>
              </figure>

              <figure class="sponsor-qr-card wechat">
                <figcaption>
                  <span><i class="pi pi-qrcode"></i></span>
                  <div>
                    <strong>微信支付</strong>
                    <small>打开微信扫一扫</small>
                  </div>
                </figcaption>
                <div class="sponsor-qr-image-shell">
                  <img :src="WECHAT_QR_URL" alt="微信收款二维码" />
                </div>
              </figure>
            </div>
          </section>
        </div>
      </Transition>

      <Transition name="sponsor-dialog">
        <div v-if="sponsorListOpen" class="sponsor-dialog-overlay" @click.self="closeSponsorList">
          <section
            ref="sponsorListRef"
            class="sponsor-dialog sponsor-list-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sponsor-list-title"
          >
            <header class="sponsor-dialog-header">
              <div class="sponsor-dialog-title-copy">
                <span class="sponsor-dialog-icon"><i class="pi pi-users"></i></span>
                <div>
                  <h3 id="sponsor-list-title">赞助名单</h3>
                  <p>感谢 {{ SPONSORS.length }} 位朋友支持 Twilight Echo</p>
                </div>
              </div>
              <button
                type="button"
                class="sponsor-dialog-close"
                aria-label="关闭赞助名单"
                @click="closeSponsorList"
              >
                <i class="pi pi-times"></i>
              </button>
            </header>

            <div v-if="SPONSORS.length > 0" class="sponsor-list-entries">
              <article
                v-for="sponsor in SPONSORS"
                :key="sponsor.id"
                class="sponsor-list-entry"
                data-te-material="content"
              >
                <div class="sponsor-list-entry-copy">
                  <strong>{{ sponsor.name }}</strong>
                </div>
                <i class="pi pi-heart-fill sponsor-list-entry-heart" aria-hidden="true"></i>
              </article>
            </div>
            <div v-else class="sponsor-list-empty">
              <span><i class="pi pi-heart"></i></span>
              <strong>赞助名单持续更新中</strong>
              <p>如需加入名单，请联系作者。</p>
              <button type="button" class="sponsor-primary-button" @click="openSponsorDialog">
                赞助作者
              </button>
            </div>
          </section>
        </div>
      </Transition>

      <Transition name="sponsor-dialog">
        <div
          v-if="qqGroupDialogOpen"
          class="sponsor-dialog-overlay"
          @click.self="closeQqGroupDialog"
        >
          <section
            ref="qqGroupDialogRef"
            class="sponsor-dialog qq-group-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="qq-group-dialog-title"
          >
            <header class="sponsor-dialog-header">
              <div class="sponsor-dialog-title-copy">
                <span class="sponsor-dialog-icon qq-group-dialog-icon">
                  <i class="pi pi-comments"></i>
                </span>
                <div>
                  <h3 id="qq-group-dialog-title">TwilightEcho 交流群</h3>
                  <p>群号：1093775290</p>
                </div>
              </div>
              <button
                type="button"
                class="sponsor-dialog-close"
                aria-label="关闭 Q 群二维码"
                @click="closeQqGroupDialog"
              >
                <i class="pi pi-times"></i>
              </button>
            </header>

            <div class="qq-group-qr-shell">
              <img :src="QQ_GROUP_QR_URL" alt="TwilightEcho 交流群二维码，群号 1093775290" />
            </div>
            <p class="qq-group-dialog-hint">使用手机 QQ 扫描二维码加入群聊</p>
          </section>
        </div>
      </Transition>
    </Teleport>
  </section>
</template>
