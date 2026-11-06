// 将示例应用的非 TS 资产（视图、静态文件）复制到 dist
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pairs = [
  ['src/examples/demo/views', 'dist/examples/demo/views'],
  ['src/examples/demo/static', 'dist/examples/demo/static'],
  ['src/examples/message-board/views', 'dist/examples/message-board/views'],
  ['src/examples/message-board/static', 'dist/examples/message-board/static'],
  ['src/examples/dinner/views', 'dist/examples/dinner/views'],
  ['src/examples/dinner/static', 'dist/examples/dinner/static'],
];

for (const [src, dest] of pairs) {
  const s = path.join(root, src);
  if (!fs.existsSync(s)) continue;
  fs.cpSync(s, path.join(root, dest), { recursive: true });
  console.log(`copied ${src} -> ${dest}`);
}
