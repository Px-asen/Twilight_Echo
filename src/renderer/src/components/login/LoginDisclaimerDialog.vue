<script setup lang="ts">
import { ref, useId } from 'vue'
import { useNativeDialog } from '../../composables/useNativeDialog.ts'

defineProps<{ providerId: string; providerName: string }>()
const emit = defineEmits<{ accept: [providerId: string]; cancel: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const titleId = `login-disclaimer-${useId()}`
useNativeDialog(dialog)
</script>

<template>
  <dialog
    ref="dialog"
    class="login-disclaimer"
    :aria-labelledby="titleId"
    @cancel.prevent="emit('cancel')"
  >
    <p class="disclaimer-provider">登录 {{ providerName }}</p>
    <h2 :id="titleId">免责声明</h2>
    <div class="disclaimer-copy">
      <p>Twilight Echo 提供插件接入能力，音源服务与内容由对应平台提供。</p>
      <p>
        使用插件须遵守对应平台的服务条款，仅访问你有权使用的内容。登录不会授予额外的会员或版权权限。
      </p>
      <p>第三方接口可能变更或限制访问。请自行判断并承担账号授权及使用插件的相关风险。</p>
    </div>
    <footer>
      <button type="button" autofocus @click="emit('cancel')">取消</button>
      <button type="button" class="disclaimer-accept" @click="emit('accept', providerId)">
        同意并继续
      </button>
    </footer>
  </dialog>
</template>

<style scoped>
.login-disclaimer {
  position: fixed;
  inset: 0;
  box-sizing: border-box;
  width: min(480px, calc(100vw - 32px));
  max-height: calc(100dvh - 48px);
  margin: auto;
  padding: 28px;
  overflow: auto;
  border: 1px solid var(--te-card-border);
  border-radius: 22px;
  background: var(--te-card-bg-solid, var(--te-card-bg));
  color: var(--te-neutral-900);
  box-shadow: 0 24px 80px rgb(0 0 0 / 24%);
  font: 14px/1.75 var(--te-font-sans);
}

.login-disclaimer::backdrop {
  background: rgb(8 12 20 / 48%);
}

.disclaimer-provider {
  margin: 0 0 6px;
  color: var(--te-neutral-500);
  font-size: 13px;
}

.login-disclaimer h2 {
  margin: 0 0 20px;
  font-size: 24px;
  line-height: 1.4;
  font-weight: 700;
}

.disclaimer-copy p {
  margin: 0 0 12px;
}

.disclaimer-copy p:last-child {
  margin-bottom: 0;
}

.login-disclaimer footer {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 26px;
}

.login-disclaimer button {
  min-height: 42px;
  padding: 9px 18px;
  border: 1px solid var(--te-card-border);
  border-radius: 12px;
  background: var(--te-subtle-bg);
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.login-disclaimer .disclaimer-accept {
  border-color: transparent;
  background: var(--te-primary-500);
  color: #fff;
  font-weight: 600;
}

.login-disclaimer button:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}

@media (max-width: 420px) {
  .login-disclaimer {
    padding: 24px;
  }

  .login-disclaimer footer button {
    flex: 1;
  }
}
</style>
