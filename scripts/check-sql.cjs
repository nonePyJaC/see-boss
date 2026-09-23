/**
 * 静态自检 pot-log-sync.sql：
 *   1. 每个函数用到的 v_xxx 变量都必须在 DECLARE 段声明
 *   2. 括号配平
 *   3. CREATE OR REPLACE FUNCTION 数量与 GRANT 数量对应
 *
 * 用法: node scripts/check-sql.cjs db/pot-log-sync.sql
 */
const fs = require('fs')

const file = process.argv[2]
if (!file) {
  console.error('用法: node scripts/check-sql.cjs <sql 文件>')
  process.exit(1)
}

const sql = fs.readFileSync(file, 'utf8')
let problems = 0

// ── 1. 拆分函数块 ──
const parts = sql.split(/CREATE OR REPLACE FUNCTION\s+/).slice(1)
if (parts.length === 0) {
  console.error('没找到任何 CREATE OR REPLACE FUNCTION')
  process.exit(1)
}

for (const part of parts) {
  const name = (part.match(/public\.(\w+)/) || [])[1] || '(匿名)'
  const bodyStart = part.search(/\bBEGIN\b/)
  const declPart = part.slice(0, bodyStart)
  const bodyPart = part.slice(bodyStart)

  // 已声明变量
  const declared = new Set(
    [...declPart.matchAll(/^\s*(v_\w+)\s+\w/gm)].map((m) => m[1])
  )
  // 用到但没声明的（排除赋值目标、排除 DECLARE 段）
  const used = new Set([...bodyPart.matchAll(/\b(v_\w+)\b/g)].map((m) => m[1]))
  const missing = [...used].filter((v) => !declared.has(v))

  // 声明了没用的（仅提示）
  const unused = [...declared].filter((v) => !bodyPart.includes(v))

  if (missing.length) {
    console.log(`FAIL ${name}: 用了未声明的变量 → ${missing.join(', ')}`)
    problems++
  } else {
    console.log(`OK   ${name}: ${declared.size} 个变量全部已声明`)
  }
  if (unused.length) {
    console.log(`     提示 ${name}: 声明未用 → ${unused.join(', ')}`)
  }
}

// ── 2. 括号配平（$$ 内的整体算） ──
const dollars = (sql.match(/\$\$/g) || []).length
if (dollars % 2 !== 0) {
  console.log(`FAIL $$ 数量为奇数 (${dollars})，函数体没闭合`)
  problems++
} else {
  console.log(`OK   $$ 配平 (${dollars / 2} 个函数体)`)
}

// ── 3. 函数与 GRANT 对应 ──
const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION\s+public\.(\w+)/g)].map((m) => m[1])
const grants = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION\s+public\.(\w+)/g)].map((m) => m[1])
for (const f of new Set(fns)) {
  if (!grants.includes(f)) {
    console.log(`FAIL ${f}: 缺少 GRANT EXECUTE`)
    problems++
  }
}
if (!problems) console.log(`OK   ${new Set(fns).size} 个函数都有 GRANT`)

console.log(problems ? `\n${problems} 个问题` : '\n静态检查通过')
process.exit(problems ? 1 : 0)
