<script setup lang="ts">
import { ref } from 'vue'
const props = defineProps<{ busy: boolean; error: string }>()
const emit = defineEmits<{ submit: [serverUrl: string, username: string, password: string] }>()
const serverUrl = ref('')
const username = ref('')
const password = ref('')
function submit(): void {
  if (props.busy) return
  emit('submit', serverUrl.value.trim(), username.value.trim(), password.value)
  password.value = ''
}
</script>
<template>
  <form class="server-login-form" @submit.prevent="submit">
    <label
      >服务器地址<input
        v-model="serverUrl"
        type="url"
        required
        placeholder="https://music.example.com/jellyfin"
        autocomplete="url"
        :disabled="busy"
    /></label>
    <label
      >用户名<input v-model="username" required autocomplete="username" :disabled="busy"
    /></label>
    <label
      >密码<input
        v-model="password"
        type="password"
        autocomplete="current-password"
        :disabled="busy"
    /></label>
    <p v-if="error" role="alert">{{ error }}</p>
    <button type="submit" :disabled="busy">{{ busy ? '正在连接…' : '连接服务器' }}</button>
  </form>
</template>
<style scoped>
.server-login-form {
  display: grid;
  gap: 18px;
  width: min(100%, 420px);
  margin: 24px auto;
}
label {
  display: grid;
  gap: 8px;
  color: var(--te-neutral-900);
}
input,
button {
  min-height: 42px;
  padding: 10px 12px;
  border: 1px solid var(--te-card-border);
  border-radius: 10px;
  background: var(--te-card-bg);
  color: var(--te-neutral-900);
  font: inherit;
}
button {
  cursor: pointer;
}
button:disabled {
  cursor: wait;
  opacity: 0.6;
}
p {
  color: var(--te-neutral-700);
}
</style>
