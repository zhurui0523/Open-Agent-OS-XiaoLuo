const fs = require('fs');
const srcPath = 'D:\\projects\\xiaoluo ai agent OS\\后台\\source\\app\\components\\canvas-view.tsx';
let c = fs.readFileSync(srcPath, 'utf8');

// Direct replacements: corrupted -> correct
// Pattern: ） replaced the missing/corrupted character + closing quote/punctuation
const fixes = [
  // L288: comment - 独立面板
  ['独立面）*/', '独立面板 */'],
  // L294: comment - 清除
  ['跳转落地后清）focus', '跳转落地后清除 focus'],
  // L300: comment - 程序卡片（画布
  ['程序））画布节点（画布', '程序卡片（画布⇄代码）：document 节点承载入口文件内容'],
  // L313: comment - 共享 hooks
  ['页签与输入条共享勾）', '页签与输入条共享 hooks'],
  // L377-378: merged lines - 原生 window.prompt（会静默返回）
  ['不支持原）window.prompt（会静默返\n回）', '不支持原生 window.prompt（会静默返回）'],
  // L381: 分享并安装"
  ['分享并安）,', '分享并安装",'],
  // L391: 由小逻生成的插件：${name}
  ['由小逻生成的插件）', '由小逻生成的插件：${'],
  // L400-401: merged code
  ['报）', '报；'],
  // L409: 分享失败：${...}
  ['分享失败）', '分享失败：${'],
  // L910: This is the modal guard comment we added - it's correct
  // L1303: file upload error
  ['文件上传失败"', '文件上传失败"'],
  // L1318: 从本地导入
  ['从本地导）', '从本地导入）'],
  // L1352: 已进入
  ['已进）', '已进入）'],
  // L1734: 保存"
  ['保存）\n', '保存"\n'],
  // L1736: 同步"
  ['同步）\n', '同步"\n'],
  // L1839: 重试。
  ['请检查文件后重试）,', '请检查文件后重试。",'],
  // L1890: 画布。
  ['仍可访问的画布）', '仍可访问的画布。'],
  // L2068: 定位
  ['点击或拖动定）', '点击或拖动定位"'],
  // L2147: 平移
  ['拖动空白处平）', '拖动空白处平移 ·'],
  // L2214: 任务。
  ['完成的任务）,', '完成的任务。",'],
  // L2245: 重试。
  ['请稍后重试）,', '请稍后重试。",'],
  // L2261: 节点。
  ['下游节点）,', '下游节点。",'],
  // L2338-2339: 面板
  ['收起小逻结果面）', '收起小逻结果面板'],
  ['查看小逻结果面）', '查看小逻结果面板'],
  // L2366: 工作台
  ['Intent 工作）', 'Intent 工作台"'],
  // L2370: 宽度
  ['工作台宽）', '工作台宽度"'],
  // L2412: 恢复。
  ['不可恢复）,', '不可恢复。",'],
  // L2424: 保存。
  ['归档保存）,', '归档保存。",'],
  // L2507: 删除。
  ['运行和删除）,', '运行和删除。",'],
  // L2555: 画布。
  ['同一张画布）', '同一张画布。'],
  // L2591: 画布。
  ['原画布）', '原画布。'],
  // L2625: 共享
  ['画布已共）', '画布已共享'],
  // L2724: 版本
  ['发布版）', '发布版本'],
  // L2802: 结果。
  ['最终结果）', '最终结果。"'],
  // L2818: 企业
  ['所在企）', '所在企业'],
  // L2820: 自己可见
  ['仅自）', '仅自己可见'],
  // L2828: 短视频, 批处理
  ['短视）', '短视频'],
  ['批处）', '批处理'],
  // L2850: 发布 / 创建
  ['已发）', '已发布'],
  ['只读链接已创）', '只读链接已创建'],
  // L2851: 复制。
  ['手动复制）', '手动复制。'],
  // L2874: 商城
  ['能力商）', '能力商城'],
];

let fixCount = 0;
for (const [from, to] of fixes) {
  if (c.includes(from)) {
    c = c.replace(from, to);
    fixCount++;
    console.log('FIXED: "' + from.substring(0, 30) + '..." -> "' + to.substring(0, 30) + '..."');
  } else {
    console.log('NOT FOUND: "' + from.substring(0, 40) + '..."');
  }
}

console.log('\nApplied ' + fixCount + '/' + fixes.length + ' fixes');

// Write the fixed file
fs.writeFileSync(srcPath, c, 'utf8');
console.log('File written successfully');