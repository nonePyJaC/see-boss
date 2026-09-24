<script setup>
/**
 * 确认弹窗。跟 useConfirm 的 askConfirm 配套。
 * 挂在 App 级别，任何页面调 askConfirm 都能弹。
 */
import { useConfirm } from '../composables/useConfirm.js'

const { state, ok, cancel } = useConfirm()
</script>

<template>
  <div v-if="state" class="cfmask" @click.self="cancel">
    <div class="cfbox" :class="{ danger: state.danger }">
      <h3 class="cftitle">{{ state.title }}</h3>
      <p class="cfmsg">{{ state.msg }}</p>
      <div class="cfrow">
        <button class="cfbtn cfbtn--ghost" @click="cancel">取消</button>
        <button class="cfbtn cfbtn--ok" @click="ok">{{ state.okText }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cfmask {
  position: fixed;
  inset: 0;
  background: rgba(93, 64, 55, .5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 24px;
}

.cfbox {
  width: 100%;
  max-width: 320px;
  background: var(--c-bg);
  border-radius: 22px;
  padding: 22px 20px 16px;
  text-align: center;
  animation: cfin .18s ease-out;
}

@keyframes cfin {
  from { transform: scale(.92); opacity: 0; }
  to { transform: none; opacity: 1; }
}

.cftitle {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 900;
}

.cfmsg {
  margin: 0 0 18px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--c-text);
  white-space: pre-line;
}

.cfrow {
  display: flex;
  gap: 10px;
}

.cfbtn {
  flex: 1;
  height: 44px;
  border: none;
  border-radius: 14px;
  font-size: 15px;
  font-weight: 800;
  cursor: pointer;
}

.cfbtn--ghost {
  background: #e8dcc4;
  color: var(--c-text-light);
}

.cfbtn--ok {
  background: linear-gradient(180deg, var(--c-primary) 0%, var(--c-primary-dark) 100%);
  color: #fff;
}

.danger .cfbtn--ok {
  background: linear-gradient(180deg, #ef5350 0%, #d32f2f 100%);
}
</style>
