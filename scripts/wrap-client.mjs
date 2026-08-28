// 把 tsc 产出的 lib/client.js（纯模块体）包上官方闭包工厂外壳，
// 与 deepseek-harness packages/client/tsdown.client.ts 的
// banner / intro / footer 契约逐字一致：
//
//   window.__ModuleLoader__.load({ id: "<id>", factory: (require) => {
//   var module = { exports: {} }; var exports = module.exports;
//   ...模块体...
//   return module.exports; } });
//
// 同时剥掉 tsc 在 NodeNext 下对无 import/export 文件追加的 `export {}`
// （该行会让经典脚本解析抛 SyntaxError）。

import { readFileSync, writeFileSync } from 'node:fs'

const id = 'dsh-role-manager'
const path = new URL('../lib/client.js', import.meta.url)

let body = readFileSync(path, 'utf8')
body = body.replace(/\nexport \{\};?\s*$/, '\n')

const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`
const intro = 'var module = { exports: {} }; var exports = module.exports;'
const footer = 'return module.exports; } });'

writeFileSync(path, `${banner}\n${intro}\n${body}${footer}\n`)
console.log(`wrap-client: ${path.pathname} wrapped as ${id}`)
