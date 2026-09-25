# Jev 体验台 · Jev Playground

一个零依赖的本地网页 Demo，用来体验 [TypeSafe](https://www.typesafe.ai) 的 **Jev（System One）决策模型**：发一段状态和几道类型化问题（choice / score / noul），拿到选项、分值和校准概率。

A zero-dependency local web demo for TypeSafe's **Jev (System One)** decision model: send a state plus typed questions, get choices, scores and calibrated probabilities back.

![邮箱收件箱场景 · Jev 推理结果：click 100%、参数命中 e33、未完成 0.040](docs/images/main.png)

## 内置场景

- **playwright-jev-agent**（Beta）—— 只输入任务目标：工程自动构造 state 与 4 道问题，Jev 每轮决策（选动作 / 选 ref / 选文本 / 判完成度），playwright-cli 操作真实浏览器，循环直到完成；每一步的请求体、概率、执行与截图在前端完整可见
- **浏览器操作（离线预设）** —— 把可访问性快照交给 Jev，直接选出「下一步调用哪个工具、作用于哪个 ref、任务是否完成」，答案落到具体 ref 而不是按钮文字
- **意图识别** —— 工单分派 / 内容审核 / 意图路由，choice · score · noul 三种题型混用
- **Agent 上下文裁剪** —— 逐条判断哪些工具调用和结果还值得留在上下文里

![订单后台推理结果：下一步 click、参数命中 e92、未完成 0.060](docs/images/browser-agent.png)

## 快速开始 / Quick Start

```bash
# Node.js 18+（Windows 可直接双击 start.bat）
node server.js
```

打开 http://localhost:3000 ，在页面顶部填入你的 TypeSafe API Key 即可使用。

### playwright-jev-agent 的环境要求（可选）

Demo 模式零依赖即可用；**playwright-jev-agent** 需要驱动本机浏览器，额外要求：

| 依赖 | 安装 | 说明 |
|---|---|---|
| Node.js 18+ | — | 启动时自动检查 |
| playwright-cli | `npm i -g @playwright/cli` | 全局安装 CLI 即可，无需下载浏览器 |
| Chrome 或 Edge | 本机已装即可 | 在「编辑配置 → 浏览器内核」里选（默认 Chrome）；选定的内核启动失败时自动换另一个重试一次 |

右上角 `browserPill` 实时显示引擎状态（✅ 引擎就绪 vX.Y.Z / ⚠ 未安装）。内置演示页（`📦 内置演示页` 按钮，`public/demo/mailbox.html`）离线即可完整演示「归档对账单 / 搜索邮件」等任务。

需要让 Jev 生成输入文本（如搜索词）时，在「⚙ 配置 → 生成模型」槽位填一个 OpenAI 兼容接口（Base URL / API Key / 模型名，只存浏览器 localStorage，经本地服务透传）。

## 配置与部署 / Configuration & Deploy

API Key 两种填法任选：**网页里填**（存浏览器 localStorage，随请求头转发，不落盘，推荐）或 **环境变量** `TYPESAFE_API_KEY`（参考 `.env.example`）。

```bash
PORT=8080 TYPESAFE_API_KEY=xxx ALLOW_ORIGIN=https://your-domain.com node server.js
```

| 环境变量 | 说明 |
|---|---|
| `PORT` | 监听端口（默认 3000） |
| `TYPESAFE_API_KEY` | 服务端兜底 API Key（可选，页面填写的 Key 优先） |
| `ALLOW_ORIGIN` | CORS 允许来源（默认 `*`，生产环境建议改成你的域名） |

- 建议挂在反向代理（nginx / caddy）后面做 HTTPS；代理层记得传 `X-Forwarded-For`，场景保存与浏览器会话都按它的首段隔离租户（SHA-1 哈希后写入 `data/`，备份该目录即备份全部数据）
- 接口由 `server.js` 代理转发到 `https://api.typesafe.ai/v1/systemone`，规避浏览器 CORS 限制；生成模型接口 `/api/llm` 同为纯透传（Base 仅允许 https 或 localhost）；静态资源带 `Cache-Control: no-cache`，发版即生效
- Auto 模式的安全边界：driver 层 27 个浏览器操作白名单硬校验（读取 / 存储 / 网络 / 会话类命令一律拒绝）、`goto` 仅 http/https、每命令 30s 超时、单步确认模式可随时人工把关

### 密集页面下的候选裁剪（高级参数）

「参数」题的选项由当前快照自动解析，一页元素太多时会撞上 Jev 接口 **255 个选项**的硬上限（实测 `public/demo/resume.html` 有 393 个元素，直接报 `Too many choices`）。所以「⚙ 配置 → 高级参数」里有三个旋钮：

| 旋钮 | 默认 | 说明 |
|---|---|---|
| 参数候选智能裁剪 | 开 | 关掉则恢复全量发送（超过 255 个选项即报错） |
| 候选元素上限 | 80 | 一页元素数**超过 250 个**时才启用裁剪，届时按相关性取前 N 个 |
| 最多候选批次数 | 3 | Jev 在前 N 个里找不到目标时会选「其他」，我们自动展开下一批；这里限总共最多几批 |

排序是确定性的工程手段，不额外请求 Jev：**目标关键词稀有度**（越少见的词越能区分目标）＋**可点击优先**＋**已失败元素降权**（ref 编号同页内稳定），并且同一张卡片最多占 4 个候选位——否则同名的一堆按钮会把候选位刷满、把真正的目标挤出去。每个选项的描述会带上所在卡片（如 `button "邀请面试"（在「候选人 周一鸣（高级前端工程师）」内）`），Jev 才分得清。

元素数 ≤ 250 的页面**完全不触发**这套逻辑，行为与之前逐字节一致。每一步的候选裁剪与补问记录都在步骤卡的「Jev 请求信息」里可见，导出记录也带。

### 动作与元素角色的兼容性校验

「动作」题与「参数」题在同一个请求里同时作答，所以动作的选择本身拿不到元素信息。实测事故：模型对 `button "发货"` 选了 `select`（中文「选中这一行」与动作名 `select` 同形），命令打到浏览器才被 playwright 的 `Element is not a <select> element` 拦下，白烧一步。

现在发命令之前先校验一次**动作 × 元素角色**，且只登记物理上不可能的组合（`select` 配非下拉框、`check`/`uncheck` 配非勾选框；角色白名单取自 playwright 注入脚本本身）。不兼容就在**同一步内补问一题「动作」**：候选已去掉该元素上不可能的动作，并附上该角色的常规动词；补不回来才记失败步。两种情况都**不会把命令发给浏览器**，元素也不会被记入「已失败降权」（它本身没问题，降权会把真正的目标挤出候选首批）。可编辑性判不了的 `fill` / `type` / `生成输入` 故意不拦 —— contenteditable 的 div 在快照里是 `generic`，按角色拦会误报，宁可漏报交给浏览器报错。

## 测试 / Tests

```bash
npm test          # 单元 + 真实 playwright-cli 冒烟（引擎不可用自动跳过）
npm run test:e2e  # Auto 模式端到端：归档 / 生成输入 / 单步 / 步数上限（默认本地 oracle，可切真实 Jev）
```

## 项目结构 / Project Structure

```
jev-demo/
├── server.js            # 本地服务：静态托管 + 接口代理（Jev / 生成模型）+ 场景保存 + 浏览器驱动接线
├── browser-driver.js    # playwright-cli 薄驱动：白名单校验 / 30s 超时 / --json 判错 / 截图工件
├── start.bat            # Windows 双击启动
├── tests/               # node:test 单元 + driver 冒烟 + E2E（oracle mock）
└── public/
    ├── index.html       # 页面结构
    ├── styles.css       # 样式（浅色极简）
    ├── presets.js       # 内置预设与三个快照生成器（邮箱 / 简历 / 订单后台）
    ├── demo/mailbox.html # 内置可交互邮箱演示页（Auto 模式离线演示用）
    └── js/
        ├── util.js          # 通用工具：宽松 JSON、快照 ref 解析
        ├── ref-funnel.js    # 候选裁剪纯逻辑：相关性排序、祖先上下文、批次切片（无 DOM）
        ├── auto-core.js     # Auto 模式纯逻辑：state/问题组装、决策解析、终止判断、LLM prompt
        ├── auto.js          # Auto 模式前端循环：步骤卡 / 时间线 / 截图 / 导出
        ├── state-editor.js  # state 表单 / 源码双模式编辑器
        ├── questions.js     # 问题卡与 criteria 结构化编辑器
        ├── output.js        # 输出渲染（概率条排序与折叠）
        └── app.js           # 预设 Tab、发送流程、场景保存、后端探测、配置弹窗（含生成模型槽位）
```

## License

[MIT](./LICENSE)
