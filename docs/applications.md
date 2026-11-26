# 官方应用与 Demo 索引（P12）

本仓库承载宙斯的**完整应用**。框架、编译器与通用工具留在 `baicie/zeus`，
组件与主题留在 `baicie/zeus-ui`。

## 应用与 Demo 的差别

两者都要能构建、能运行，但**交付要求不同**：

| | 应用 | Demo |
| --- | --- | --- |
| Dockerfile | 有 | 无 |
| 镜像与 SBOM | 有，且有体积预算 | 无 |
| 部署单元 | `products.json` 里的 `deploymentUnit` | 无 |
| 生产部署 | 有，需要授权 | 从不部署 |
| CI | 构建 + 浏览器验收 + 镜像门禁 | 构建 + 类型检查 |
| 状态记录 | 八级生命周期 | 只需"能构建" |

不要给每个复杂 Demo 造镜像、数据库或生产部署。那边的成本远大于收益。

## 应用

### Admin — `apps/admin`

产品外壳。路由、查询、i18n、用户管理、表单与数据网格，构建在已发布的组件库之上。

- **Zeus 包**：30 个（`@zeus-js/zeus`、`router`、`query`、`resource`、`i18n` + 26 个 `@zeus-web/*`）
- **启动**：`pnpm --filter ./apps/admin dev`
- **构建**：`pnpm --filter ./apps/admin build`
- **部署**：`deploymentUnit: admin`
- **地址**：`https://admin.moonbyte.top:8443/`（生产，运行的是**旧实现**——见
  `migration-checklist.md` 的说明，迁移后的版本尚未部署）
- **状态**：`DEPLOYMENT_REHEARSED`

### AI Workbench — `apps/ai-workbench`

对话外壳。两种模式（host-owned 与 BYOK）、一个由运维显式放行 origin 的 CSP 边界、
以及已发布 demo 的 replay 面。

- **Zeus 包**：6 个
- **启动**：`pnpm --filter ./apps/ai-workbench dev`
- **部署**：`deploymentUnit: ai`（与 AI Host 同一单元）
- **地址**：`https://ai.moonbyte.top:8443/`（生产运行旧实现）
- **状态**：`IMAGE_VALIDATED`

### AI Host — `apps/ai-host`

Workbench 背后的参考服务。SSE 流式、带幂等键的命令、审批、SQLite 持久化。
它是参考实现，不是 LLM 网关——它从不调用模型。

- **Zeus 包**：2 个
- **启动**：`pnpm --filter ./apps/ai-host dev`
- **健康检查**：`/health`
- **状态**：`IMAGE_VALIDATED`

### Playground — `apps/playground`

编辑器。CodeMirror 之上跑 Rust 编译器的 WASM 构建，分栏预览，用户代码的沙箱运行，
项目持久化与分享链接。

- **Zeus 包**：8 个（含 `@zeus-js/compiler-wasm@0.1.1-beta.20` 与 `playground-engine@0.2.0-rc.5`）
- **启动**：`pnpm --filter ./apps/playground dev`
- **构建**：`pnpm --filter ./apps/playground build`
- **部署**：`deploymentUnit: playground`
- **状态**：`SOURCE_MIGRATED`

**它是唯一运行不可信代码的应用**，所以有两个 origin：`:80` 受信 host，`:81` sandbox。
沙箱的响应头 `Content-Security-Policy: sandbox allow-scripts` 才是 opaque origin 的来源。
把两者部署到同一个 origin 会静默失去隔离。

**尚未部署。** 生产 Playground 目前仍由 `baicie/zeus` 的
`examples/playground-editor` 构建。删掉它之前，这个应用必须先通过 CI 并产出过镜像。

## Demo

Demo 计划放在 `demos/`，该目录**尚未建立**。分类已在
`baicie/zeus` 的 `docs/architecture/r19-demo-classification.md` 完成，
搬迁要等这里有了结构再逐个进行。

| Demo | 来源 | 演示什么 | 状态 |
| --- | --- | --- | --- |
| Project Board | `zeus/examples/project-board` | 响应式状态、列表、组件组合、复杂交互 | 待迁 |
| Headless Demo | `zeus/examples/headless-demo` | 四个 headless 包如何拼起来 | 待迁 |
| Registry React | `zeus/examples/registry-react` | registry 在 React 里的消费 | 待迁 |
| use-headless-{cli,react,vue} | `zeus/examples/` | 三种框架下的最小消费 | 待迁 |

留在 core 的（分类为测试 fixture，不是 Demo）：`devtools-panel`、`next-boundary`、
`headless`。

## 相关文档

- 迁移状态：[`migration-checklist.md`](migration-checklist.md)
- 兼容性矩阵：[`compatibility-matrix.json`](compatibility-matrix.json)
- 应用清单：[`demo-catalog.md`](demo-catalog.md)
- 产品契约：[`../infra/contracts/products.json`](../infra/contracts/products.json)
