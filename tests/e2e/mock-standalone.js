/* 手动调试 / 可视化验证用：把 E2E 的 oracle mock 独立跑起来并打印端口。
 * 用法：node tests/e2e/mock-standalone.js
 * 然后在页面「⚙ 配置」里：
 *   - 接口地址填 http://127.0.0.1:<sysonePort>/v1/systemone（Key 随便填）
 *   - 生成模型 Base URL 填 http://127.0.0.1:<llmPort>/v1
 * 即可在无真实 Jev Key 的情况下完整体验 Auto 浏览器闭环。Ctrl+C 退出。 */
const { startMocks } = require('./mock-server');

startMocks().then((m) => {
  console.log('[mock-standalone] System One oracle: http://127.0.0.1:' + m.sysonePort + '/v1/systemone');
  console.log('[mock-standalone] LLM mock        : http://127.0.0.1:' + m.llmPort + '/v1');
  console.log('[mock-standalone] 按Ctrl+C 退出');
}).catch((e) => {
  console.error('[mock-standalone] 启动失败：' + (e && e.message || e));
  process.exit(1);
});
