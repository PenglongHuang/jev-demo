# Jev 体验台 · Jev Playground

一个零依赖的本地网页 Demo，用来体验 [TypeSafe](https://www.typesafe.ai) 的 **Jev（System One）决策模型**：发一段状态和几道类型化问题（choice / score / noul），拿到选项、分值和校准概率。

A zero-dependency local web demo for TypeSafe's **Jev (System One)** decision model: send a state plus typed questions, get choices, scores and calibrated probabilities back.

![邮箱收件箱场景 · Jev 推理结果：click 100%、参数命中 e33、未完成 0.040](docs/images/main.png)

## 内置场景

- **playwright-jev-agent**（Beta）—— 只输入任务目标：工程自动构造 state 与 3 道固定问题（选动作 / 选 ref / 判完成度），Jev 每轮决策后按需补问（参数批次 / 动作冲突 / 文本取值），playwright-cli 操作真实浏览器，循环直到完成；每一步的请求体、概率、执行与截图在前端完整可见。**任务目标 / 起始 URL / 输入变量在主面板就地可编辑**（运行参数在「⚙ 运行参数」弹窗里），**出错原因常驻页面顶部**——整段可选中、带「⧉ 复制」按钮，不再只弹一条 2 秒就消失的提示
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
| playwright-cli | `npm i -g @playwright/cli` | 全局安装 CLI 即可，无需下载浏览器。需 ≥ 0.1.17（0.1.18+ 的结构化快照已内置转写适配；0.1.1 等老版不支持 `--json`，health 会显示就绪但 open 报错） |
| Chrome 或 Edge | 本机已装即可 | 在「⚙ 运行参数 → 浏览器内核」里选（默认 Chrome）；选定的内核启动失败时自动换另一个重试一次（仅前两种模式，见下） |

右上角 `browserPill` 实时显示引擎状态（✅ 引擎就绪 vX.Y.Z / ⚠ 未安装）。内置演示页（`📦 内置演示页` 按钮，`public/demo/mailbox.html`）离线即可完整演示「归档对账单 / 搜索邮件」等任务。

#### 浏览器模式：用哪一份登录态

「⚙ 运行参数 → 浏览器模式」三档，决定 run 期间驱动的是哪个浏览器实例：

| 模式 | 起什么 | 登录态 | 会不会碰你日常的浏览器 |
|---|---|---|---|
| **独立实例**（默认） | 每次全新实例，profile 不落盘，关掉即消失 | 每次都要重新登 | 不会 |
| **持久登录** | 仍是我们自己起的窗口，profile 落盘在 `data/browser-profile/` | 首次在窗口里手动登一次，之后每个 run 复用 | 不会（是另一个独立进程，可与日常浏览器同时开着） |
| **CDP 直连** | 不启动浏览器，attach 到你**已经开着调试端口**的那个 Chrome/Edge | 直接用它当前的登录态 | **会** —— 见下方安全边界 |

CDP 直连的前置条件与做法（顺序很重要）：

1. **用平常的方式启动 Chrome**——**不要**加 `--remote-debugging-port`。Chrome 136+ 在默认 profile 上会**忽略**这个参数（实测：带了参数反而完全不绑调试端口），而它需要一个带登录态的默认 profile 才有意义。
2. 在那个浏览器里打开 `chrome://inspect/#remote-debugging`，勾选「Allow remote debugging for this browser instance」。勾好之后 Chrome 自己会绑端口并把端口号与 ws 路径写进 profile 目录的 `DevToolsActivePort`。
3. 在页面里选「CDP 直连」、**端点留空**（自动探测），点开始。这时 Chrome 会弹一个「Allow remote debugging?」的确认框 —— **点允许**。注意：**授权是按连接给的，每次新连接都要点一次**；同一个服务进程内后续 run 会复用这条连接，不再打扰你。没弹框时，回到第 2 步把勾选框**取消再重新勾上**，然后再点开始（**别反复重试**：挂着的连接才是让弹框留在屏幕上的东西，重试会把弹框打掉）。
4. 端点通常**留空**（自动探测）。也可以手填，但**只认 `ws://` 形态**：`ws://127.0.0.1:9222/devtools/browser/<uuid>`（`DevToolsActivePort` 第二行那条）。Chrome 147+ 在默认 profile 上关掉了 `/json/*` HTTP 发现，所以 `http://127.0.0.1:9222` 这种形态 **Playwright 用不了** —— 它会去取 `/json/version` 拿到 404，然后报 `This does not look like a DevTools server, try connecting via ws://.`。填了 http 形态时：驱动**先按你填的试**（端口文件是磁盘残留物，可能属于另一个浏览器，静默换掉会把一个本来能连的端点变成连不上的），只有在它回 404 那条死路时才回退到本机端口文件里那条 ws，并提示一句「端点已自动改用 …」。**403（授权没点）绝不重试** —— 重试会把授权弹框打掉。

页面在选中该模式时会自动预检（只读端口文件 + TCP 探活，**不做 ws 握手**，避免把弹框打掉），并把结果与做法写在警示条里。

> 本机实测（Chrome 153 + 深信服 aTrust/EDR 环境）：以上流程可以正常 attach 到日常浏览器并读到其登录态；曾误判为"Cannot"，原因就是上面几条（给 Chrome 加了参数、拿 404 当失败、重试把弹框打掉、以及端点框里留着 http 形态）。
> 记录里的 `meta.mode` / `meta.cdp` 会落盘，排查"这次到底连的哪儿"不必再靠猜。

CDP 直连下的四条硬约束（`tests/cdp-attach.spec.js` 逐条验收）：

1. 只在**它自己新建的专用标签页**里操作，你已开的标签页不会被导航、不会被点；运行开始前就开着的那些标签页被记为「你的」，Jev 想 `tab-select` 切过去会被直接拒（切到自己在运行中打开的新 Tab 是允许的，切过去后驱动会给那个页重新打标记，运行继续）
2. 窗口尺寸 / 全屏一类动作**拒绝执行** —— 那是你的窗口，不是我们起的实例
3. 你手动关掉那个专用标签页 → 立刻停手报错（每一步的**快照 / 点击 / 取位置 / 截图**下发前都会先确认当前标签页还是我们那一个），绝不会退到你隔壁的页面上继续点、更不会把那个页面拍进运行记录
4. 「关闭浏览器」按钮只**断开连接**，你的浏览器不会被关掉（标签页也保留）

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
- Auto 模式的安全边界：driver 层 19 个浏览器操作白名单硬校验（读取 / 存储 / 网络 / 会话 / 坐标鼠标类命令一律拒绝）、`goto` 仅 http/https、每命令 30s 超时、单步确认模式可随时人工把关。默认的「独立实例」模式每次都是干净的一次性 profile，**不碰你日常的浏览器**；「持久登录」用的是专用 profile（`data/browser-profile/`，随 `data/` 一起备份/忽略）；只有你显式选「CDP 直连」时才会操作你正在使用的浏览器，且严格遵守上方那四条硬约束

### 密集页面下的候选裁剪（高级参数）

「参数」题的选项由当前快照自动解析，一页元素太多时会撞上 Jev 接口 **255 个选项**的硬上限（实测 `public/demo/resume.html` 有 393 个元素，直接报 `Too many choices`）。所以「⚙ 配置」里的 **高级参数**（可折叠分节，点标题行展开；标题右侧一直写着当前值，收起也不会"看不见"）里有三个旋钮：

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

### 原生弹窗（confirm / alert / prompt）

页面触发原生对话框期间，playwright 的其余工具会被拒绝（`does not handle the modal state`），循环拿不到快照 —— 修复前这里直接以「出错」终止整个运行。现在这一轮自动转为**弹窗步**：快照换成一句阻塞说明，只问 Jev 一道「动作」题（`dialog-accept` / `dialog-dismiss`），弹窗处理完，下一轮即恢复正常快照。内置邮箱场景的「删除邮件（确认框选接受）」走的正是这条路径。

### select 的选项预检

「动作 × 角色」校验之外，`select` 还可能错在**选项层**：把「搜索王小明」误规划成「在“订单状态”下拉框里选“王小明”这个选项」—— 选项不存在，浏览器必报 option not found，且模型可能连续重复同一错误组合。快照里下拉框子树自带选项名单（option 无 ref 但有名字），发命令前做确定性预检：选项不在名单内就**不发命令**，报错直接列出全部可选选项，并按两种可能的本意给纠偏提示（想切下拉框 → 「文本」补问里改选正确的选项名；想输入文本 → 改用 fill + 搜索框），作为下一轮的信号；读不到选项名单时放行（宁可漏报，交回浏览器判定）。

### 「文本」补问：候选跟着动作走

需要输入文本的动作（fill / type / select / press / goto / upload / tab-select / tab-close / dialog-accept / tab-new），其取值在**动作与参数落定之后**才以单题补问发出，候选按动作分型：`select` 给该下拉框当时的**真实选项名**（「在订单状态下拉框选王小明」这类错误从候选层面就构造不出来）；`press` 给变量池 ∪ 常用键名（Enter / PageDown / PageUp 等，与变量撞名时变量优先）；其余动作给**变量池**（动态值全部工程注入）；可选文本的动作（tab-close / tab-new / dialog-accept）额外附「无」。选中的候选不在变量池时按字面值直传，所以选项名与键名无需配变量。必填动作零候选（如 fill 但变量池为空）会记一个不打 Jev、不发命令的确定性失败步。

## 测试 / Tests

```bash
npm test          # 单元 + 真实 playwright-cli 冒烟（引擎不可用自动跳过）
                  # 含三种浏览器模式的验收：CDP 直连（自拉临时浏览器验四条硬约束）、
                  # 持久 profile（验目录落在 data/ 下且关掉再开不被重置）
npm run test:e2e  # Auto 模式端到端：归档 / 生成输入 / 单步 / 步数上限 / 弹窗 / select 补问 /
                  # 哨兵标签 / 外层就地编辑+错误条（可选中可复制）（默认本地 oracle，可切真实 Jev）
                  # S9：UX 不变量回归护栏（14 项修复的 DOM 与几何断言，**不跑任务**、不吃 oracle）；
                  # 单独复核：E2E_ONLY=s9 node tests/e2e/run.js
```

## 项目结构 / Project Structure

```
jev-demo/
├── server.js            # 本地服务：静态托管 + 接口代理（Jev / 生成模型）+ 场景保存 + 浏览器驱动接线
├── browser-driver.js    # playwright-cli 薄驱动：白名单校验 / 三种浏览器模式（独立 / 持久 profile / CDP 直连）/ 30s 超时 / --json 判错 / 截图工件
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
