# Jev 体验台 · Jev Playground

一个零依赖的本地网页 Demo，用来体验 [TypeSafe](https://www.typesafe.ai) 的 **Jev（System One）决策模型**：发一段状态和几道类型化问题（choice / score / noul），拿到选项、分值和校准概率。

A zero-dependency local web demo for TypeSafe's **Jev (System One)** decision model: send a state plus typed questions, get choices, scores and calibrated probabilities back.

![邮箱收件箱场景 · Jev 推理结果：click 100%、参数命中 e33、未完成 0.040](docs/images/main.png)

## 内置场景

- **浏览器操作** —— 把可访问性快照交给 Jev，直接选出「下一步调用哪个工具、作用于哪个 ref、任务是否完成」，答案落到具体 ref 而不是按钮文字
- **意图识别** —— 工单分派 / 内容审核 / 意图路由，choice · score · noul 三种题型混用
- **Agent 上下文裁剪** —— 逐条判断哪些工具调用和结果还值得留在上下文里

![订单后台推理结果：下一步 click、参数命中 e92、未完成 0.060](docs/images/browser-agent.png)

## 快速开始 / Quick Start

```bash
# Node.js 18+（Windows 可直接双击 start.bat）
node server.js
```

打开 http://localhost:3000 ，在页面顶部填入你的 TypeSafe API Key 即可使用。

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

- 建议挂在反向代理（nginx / caddy）后面做 HTTPS；代理层记得传 `X-Forwarded-For`，场景保存按它的首段隔离租户（SHA-1 哈希后写入 `data/ws_<hash>.json`，备份该目录即备份全部用户场景）
- 接口由 `server.js` 代理转发到 `https://api.typesafe.ai/v1/systemone`，规避浏览器 CORS 限制；静态资源带 `Cache-Control: no-cache`，发版即生效

## 项目结构 / Project Structure

```
jev-demo/
├── server.js            # 本地服务：静态托管 + 接口代理 + 场景保存
├── start.bat            # Windows 双击启动
└── public/
    ├── index.html       # 页面结构
    ├── styles.css       # 样式（浅色极简）
    ├── presets.js       # 内置预设与三个快照生成器（邮箱 / 简历 / 订单后台）
    └── js/
        ├── util.js          # 通用工具：宽松 JSON、快照 ref 解析
        ├── state-editor.js  # state 表单 / 源码双模式编辑器
        ├── questions.js     # 问题卡与 criteria 结构化编辑器
        ├── output.js        # 输出渲染（概率条排序与折叠）
        └── app.js           # 预设 Tab、发送流程、场景保存、后端探测
```

## License

[MIT](./LICENSE)
