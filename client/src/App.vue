<script setup>
import { useRouter } from 'vue-router'

const router = useRouter()
</script>

<template>
  <!-- 所有页面共用外壳：路由出口 -->
  <!-- 登录态不在这里拦：账号档案由各页面自己查（/api/account/me），
       这里写死 localStorage 判断会跟服务端口径不一致（踩过：
       user store 改成只读服务端后，旧 key 没人写了，导致每次启动都被踢到注册页） -->
  <router-view v-slot="{ Component }">
    <keep-alive include="LobbyView">
      <component :is="Component" />
    </keep-alive>
  </router-view>
</template>
