/**
 * 静态自检：抓「用了没 import 的标识符」这类低级错误。
 *
 * 背景：main.js 里写了 repo.myAccount() 却漏 import repo，
 *       上线后报 `repo is not defined`，牵连出登录态丢失、
 *       退出卡死、`_ is not a function` 等一系列怪现象。
 *       Vite 对这种「运行时才炸」的错误不报编译错。
 *
 * 做法（务实近似，非完整 JS 解析器）：
 *   1. 收集文件里所有 import 进来的名字
 *   2. 收集全局内置 + 本文件声明的名字
 *   3. 找出「被调用/访问但不在上述集合」的标识符
 * 已知局限：模板字符串、对象方法同名等可能误报，需人工过一眼。
 *
 * 用法: node scripts/check-imports.cjs client/src
 */
const fs = require('fs')
const path = require('path')

const ROOT = process.argv[2] || 'client/src'

const BUILTIN = new Set([
  'window', 'document', 'console', 'localStorage', 'sessionStorage', 'navigator',
  'location', 'history', 'fetch', 'Promise', 'JSON', 'Math', 'Date', 'Object',
  'Array', 'String', 'Number', 'Boolean', 'Set', 'Map', 'RegExp', 'Error',
  'TypeError', 'Buffer', 'process', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'requestAnimationFrame', 'structuredClone', 'URL', 'URLSearchParams',
  'atob', 'btoa', 'decodeURIComponent', 'encodeURIComponent', 'escape', 'unescape',
  'confirm', 'alert', 'undefined', 'null', 'true', 'false', 'this', 'super',
  'arguments', 'require', 'module', 'exports', 'globalThis',
])

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue
      walk(p, out)
    } else if (/\.(js|mjs|vue)$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

const files = walk(ROOT)
let problems = 0

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  // 只查 <script setup> 段（.vue 里有模板语法会干扰）
  let code = src
  if (file.endsWith('.vue')) {
    const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
    if (!m) continue
    code = m[1]
  }

  const known = new Set(BUILTIN)

  // import 的名字
  for (const m of code.matchAll(/import\s+([^'"]+?)\s+from\s+['"][^'"]+['"]/g)) {
    const clause = m[1]
    // import { a, b as c } from '...'
    for (const n of clause.matchAll(/[A-Za-z_$][\w$]*/g)) {
      known.add(n[0])
    }
    // import Default from '...'
    if (!clause.includes('{')) known.add(clause.trim().split(/\s*,\s*/).pop())
  }
  // import './x' 无绑定
  // 本地声明：const/let/var/function/class + 解构
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1])
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]+)\}/g)) {
    for (const n of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) known.add(n[0])
  }
  for (const m of code.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1])
  for (const m of code.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1])
  // macro 关键字
  for (const m of code.matchAll(/\b(defineProps|defineEmits|defineExpose|defineModel|withDefaults)\b/g)) {
    known.add(m[1])
  }
  // import() 动态导入的路径不是标识符，跳过

  // 找出疑似未定义调用：xxx(  或 xxx.
  const used = new Set()
  for (const m of code.matchAll(/(?:^|[^\w$.'"`])([A-Za-z_$][\w$]*)\s*\(/g)) used.add(m[1])
  for (const m of code.matchAll(/(?:^|[^\w$.'"`])([A-Za-z_$][\w$]*)\s*(?=\.\w)/g)) used.add(m[1])

  const missing = [...used].filter((n) => !known.has(n) && !/^[A-Z]/.test(n))
  if (missing.length) {
    console.log(`FAIL ${file}: 疑似未定义 → ${missing.join(', ')}`)
    problems++
  }
}

console.log(problems ? `\n${problems} 个文件有疑点` : `\n${files.length} 个文件检查通过`)
process.exit(problems ? 1 : 0)
