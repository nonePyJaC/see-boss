/**
 * 生成 H5 入口二维码 PNG
 * 用法: node client/gen-qr.mjs
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const QRCode = require('qrcode')

const URL = 'https://see-boss-d2gjggfbz8808d1d4-1492320391.tcloudbaseapp.com/cangshu-web/'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '仓鼠聚会-二维码.png')

const opts = {
  errorCorrectionLevel: 'H', // 30% 容错，屏幕显示、打印、拍照都稳
  margin: 2, // 留白模块数，WeChat 扫码需要 quiet zone
  width: 640,
  color: {
    dark: '#3E2723',
    light: '#FFFFFF',
  },
}

const dataURI = await QRCode.toDataURL(URL, opts)
const buf = Buffer.from(dataURI.replace(/^data:image\/png;base64,/, ''), 'base64')
fs.writeFileSync(OUT, buf)

console.log('URL : ' + URL)
console.log('file: ' + OUT)
console.log('size: ' + buf.length + ' bytes, 640x640 px, ECC level H')
