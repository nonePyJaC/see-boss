<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
if (!localStorage.getItem('hamster-poker:user')) router.replace('/register')
</script>

<template>
  <!-- 所有页面共用外壳：phone frame + 路由出口 -->
  <router-view v-slot="{ Component }">
    <keep-alive include="LobbyView">
      <component :is="Component" />
    </keep-alive>
  </router-view>
</template>
