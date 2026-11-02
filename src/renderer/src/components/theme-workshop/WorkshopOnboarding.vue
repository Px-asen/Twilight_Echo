<script setup lang="ts">
import { WORKSHOP_TEMPLATES } from '../../../../shared/themeWorkshop.ts'
defineProps<{ step: number; hasProject: boolean; busy: boolean; creating: boolean }>()
const emit = defineEmits<{ step: [step: number]; create: [template: string]; close: [] }>()
const steps = [
  { name: '选择模板', description: '先选择一个接近你想法的起点，也可以复制已安装主题。' },
  {
    name: '背景与配色',
    description: '调整主题色和背景，两套颜色可以分别编辑。所有修改会自动保存。'
  },
  { name: '调整组件', description: '点选画布跳到对应设置。导入图片后可添加图层，直接拖动和缩放。' },
  {
    name: '检查深浅色',
    description: '切换深浅色与窗口宽度，打开实时检测，点击问题即可定位并修复。'
  },
  {
    name: '应用或导出',
    description:
      '整窗试用可随时按 Esc 退出。应用后的主题会保留在本机；.tep 可分享，可编辑项目可继续创作。'
  }
]
</script>
<template>
  <section class="workshop-onboarding" aria-label="主题制作引导">
    <div class="workshop-inline">
      <strong>五步制作自己的主题</strong
      ><button class="workshop-guide-close" @click="emit('close')">跳过引导</button>
    </div>
    <ol class="workshop-steps">
      <li v-for="(item, index) in steps" :key="item.name">
        <button
          :aria-current="step === index ? 'step' : undefined"
          :disabled="!hasProject && index > 0"
          @click="emit('step', index)"
        >
          <span>{{ index + 1 }}</span
          >{{ item.name }}
        </button>
      </li>
    </ol>
    <p>{{ steps[step].description }}</p>
    <div v-if="creating || !hasProject" class="workshop-template-grid">
      <button
        v-for="template in WORKSHOP_TEMPLATES"
        :key="template.id"
        :disabled="busy"
        @click="emit('create', template.id)"
      >
        <span :class="['workshop-template-thumb', template.id]" aria-hidden="true"
          ><span></span><i></i><i></i></span
        ><strong>{{ template.name }}</strong
        ><small>{{ template.description }}</small>
      </button>
    </div>
    <div v-else class="workshop-inline">
      <button :disabled="step === 0" @click="emit('step', step - 1)">上一步</button
      ><button
        class="workshop-primary"
        @click="step === 4 ? emit('close') : emit('step', step + 1)"
      >
        {{ step === 4 ? '完成引导' : '下一步' }}
      </button>
    </div>
  </section>
</template>
