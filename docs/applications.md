# 官方应用与 Demo 索引（P12）

本仓库承载宙斯的**完整应用**。框架、编译器与通用工具留在 `baicie/zeus`，
组件与主题留在 `baicie/zeus-ui`。

本页的每一条"存在 / 可访问 / 通过"都标注了依据。实测时点：**2026-11-26**
（本地 Node v22.12.0；CI 结论取 GitHub Actions 的 run 记录；URL 取当日 HTTP 响应）。
没有实测依据的，写"未验证"，不写"应该有"。

## 0. 先纠正一条前提：Playground 的位置在本轮变了

本任务书写作时的前提是"Playground 还不在这里，仍在 `zeus/examples/playground-editor`"。
这个前提在任务执行期间被改变了：

- `apps/playground` **现在存在**（commit `6bbdd02`，2026-11-26），源码从 core 原样搬入，
  依赖全部换成已发布版本；
- 但**交付没有跟着迁**：它的镜像构建失败（见下），本仓库没有构建过它的镜像、
  没有部署过它；
- **线上与 Pages 仍由 `baicie/zeus` 构建**，构建源仍是 `examples/playground-editor`。

所以下面把它列为"应用（源码已迁入，交付未达成）"，并单独写明它**不是**这里的
部署产物。

## 1. 应用与 Demo 的差别

两者都要"能构建、能跑"，但交付要求不同，这是本仓库划分目录的依据：

| | 应用（`apps/`） | Demo（`demos/`，尚未建立） |
| --- | --- | --- |
| Dockerfile | 有 | 无 |
| `products.json` 条目 | 有，含端口、健康路径、体积预算 | 无 |
| 镜像与 SBOM | 有，CI 构建并留证据 | 无 |
| 部署单元 | 有 `deploymentUnit`，可生成部署计划 | 无 |
| 生产部署 | 有，且需要授权 | 从不部署 |
| CI | 类型检查 + 构建 + 浏览器门禁 + 镜像门禁 | 类型检查 + 构建 |
| 状态记录 | 八级生命周期（`migration-checklist.md`） | 只需"能构建" |

不要给每个复杂 Demo 造镜像、数据库或生产部署。把 Demo 塞进应用生命周期，
结果是维护四条没人部署的生产流水线。

## 2. 应用

| 应用 | 路径 | 生命周期 | 镜像 CI | 部署单元 | 生产 / Demo 地址 |
| --- | --- | --- | --- | --- | --- |
| Admin | `apps/admin` | `DEPLOYMENT_REHEARSED` | 通过 | `admin` | <https://admin.moonbyte.top:8443/>（旧实现） |
| AI Workbench | `apps/ai-workbench` | `DEPLOYMENT_REHEARSED` | 通过 | `ai` | <https://ai.moonbyte.top:8443/>（旧实现） |
| AI Host | `apps/ai-host` | `DEPLOYMENT_REHEARSED` | 通过 | `ai`（与 Workbench 同单元） | 不公开，仅由 Workbench 代理 |
| Playground | `apps/playground` | `CI_VALIDATED` | **失败** | `playground`（产品有、单元未定义） | <https://playground.moonbyte.top:8443/>（由 zeus 构建） |

生命周期以 `migration-checklist.md` 的严格定义为准：`IMAGE_VALIDATED` 需要
`delivery-evidence/v1` 文件，而本仓库不存在任何一份。`demo-catalog.md` 对 AI 两个
应用记的是 `IMAGE_VALIDATED`（依据是容器内门禁通过），两处口径不同，本页记严格值。

### Admin — `apps/admin`

**演示什么。** 产品外壳：Router 嵌套路由与 loader、Query 缓存与乐观更新、i18n、
用户管理、表单、真实 DataGrid；真实 HTTP 后端（SQLite、会话 Cookie、CSRF、
限流、审计、上传）。组件只在挂载时初始化，页面切换保持同一个 layout DOM 节点。

**Zeus 包（精确）。** 30 个：5 个 `@zeus-js/*`（`zeus`、`router`、`query`、`resource`、
`i18n`）+ 25 个 `@zeus-web/*`（accordion、alert、avatar、badge、button、card、
checkbox、collapsible、data-grid、dialog、dropdown-menu、form-field、input、label、
popover、progress、radio-group、select、separator、skeleton、switch、tabs、textarea、
toast、tooltip），全部 `0.2.0-rc.5` / `0.1.0-beta.35`；构建期还有
`@zeus-js/vite-plugin@0.0.6` 与 `@zeus-js/devtools-consumer@0.1.1-beta.15`。

**启动（两个进程，真实 API）。** 服务端拒绝少于 12 字符的密码，也没有默认弱口令：

```sh
ZEUS_ADMIN_EMAIL=ada@example.test \
ZEUS_ADMIN_PASSWORD=<12+ chars> \
ZEUS_ADMIN_VIEWER_PASSWORD=<12+ chars> \
  pnpm --filter @zeus-ecosystem/admin dev:api     # API on 8787

pnpm --filter @zeus-ecosystem/admin dev            # Vite, proxies /api -> 8787
```

单进程（静态 + API 同端口，生产形态）：`pnpm --filter @zeus-ecosystem/admin build`
之后 `ZEUS_ADMIN_PASSWORD=<12+ chars> pnpm --filter @zeus-ecosystem/admin start`。

**构建与验收。** 本地 `tsc --noEmit` 与 `vite build` 通过；单测 68 项（8 个文件，
其中 `server/__tests__` 26 项）；CI `Apps build` 通过（run `45829154399`，commit `1551b25`）。浏览器门禁：
14 个产品场景 × 3 引擎、16 项权限断言、8 项视觉结构比对（像素仅 1/8 可比，
`roles` 1.68% 且差异是候选新增内容；设计审查需人工）。跨版本演练 20/20 步通过。

**地址。** 生产 <https://admin.moonbyte.top:8443/>（200，`/api/health` 返回
`{"ok":true}`），其 `build-info.json` 是 `0.2.0-rc.3`、构建于 2026-11-23——**线上是
旧实现，不是本应用**。只读 Pages demo：<https://baicie.github.io/zeus-demos/admin/>
（200，由已删除的 `zeus/demos-pages.yml` 最后一次构建，见 §5）。

**部署方法。** 单镜像（SPA + esbuild 打包的 API），`products.json` 端口 8787、
健康路径 `/api/health`；释放载体 `apps/admin/deploy/docker-compose.deploy.yml`
（只拉镜像，不构建）；数据在 `/data` 卷；TLS 由受信 ingress 终止。部署计划由
`scripts/release/deployment-plan.mjs --unit admin` 生成，从不自动执行。

### AI Workbench — `apps/ai-workbench`

**演示什么。** 对话外壳：Host 模式（快照唯一权威、写操作走审批）与 BYOK 模式
（浏览器直连用户自己的网关，AES-GCM vault，密钥不进 Host），一个由运维显式放行
origin 的 CSP 边界，以及已发布 demo 的 replay 面。任一时点只挂载一个 composer。

**Zeus 包。** 6 个：`@zeus-js/zeus`、`@zeus-js/runtime-dom` +
`@zeus-web/ai-core`、`ai-adapters`、`ai-primitives`、`ai-wc`；构建期
`@zeus-js/vite-plugin@0.0.6`。

**启动（先 Host，后外壳）。** 需要注入 Bearer token；workbench 的 Vite 代理在
服务端注入，token 不进浏览器：

```sh
ZEUS_AI_TOKENS='[{"token":"local-workbench-token-0123456789","tenantId":"reference","userId":"workbench","role":"admin"}]' \
  pnpm --filter @zeus-ecosystem/ai-host dev

ZEUS_AI_HOST_ORIGIN=http://127.0.0.1:8788 \
ZEUS_AI_UPSTREAM_TOKEN=local-workbench-token-0123456789 \
  pnpm --filter @zeus-ecosystem/ai-workbench dev   # 127.0.0.1:5191
```

**构建与验收。** 本地 `tsc` 与 `vite build` 通过；单测 16 项；CI `AI Apps` 通过
（run `45829154513`，commit `1551b25`，含三引擎 P0 72 项、BYOK 69 项、CSP 5 项）。本地产物会写
`dist/build-info.json`（发布契约 + lockfile 摘要，非 synthetic）。

**地址。** 生产 <https://ai.moonbyte.top:8443/>（200，`/healthz` 返回 `ok`，
`/ai-host/health` 200），`build-info.json` 指向 core `7fc9d718` / ui `cbb8b6c0`、
构建于 2026-11-26——**同样是旧实现**：由 `zeus-ui` 的 `ai-workbench-image.yml`
从 `examples/ai-workbench` 构建，不是本仓库的产物。只读 Pages demo：
<https://baicie.github.io/zeus-demos/ai/>（200）。

**部署方法。** 与 AI Host 同一 `ai` 单元、顺序 host → workbench（版本偏差等于坏部署，
不是降级）；两个服务写在同一份 `apps/ai-workbench/deploy/docker-compose.deploy.yml` 里；
Host 只 `expose: 8788`，workbench 的 nginx 把 `/ai-host/` 代理过去并注入 token；
`ZEUS_AI_PUBLIC_REPLAY=true` 时 Host 拒绝一切写操作。安全边界在 Workbench 的 nginx，
不在浏览器。

### AI Host — `apps/ai-host`

**演示什么。** Workbench 背后的参考服务：SSE 流式、带幂等键的命令、审批、
快照折叠、工作区路径围栏、`node:sqlite` 持久化。它是参考实现，**不是 LLM 网关**，
从不调用模型；live 模式在无 provider 密钥时 fail closed。

**Zeus 包。** 2 个：`@zeus-web/ai-core`、`@zeus-web/ai-adapters`（无 `@zeus-js/*`）。

**启动。** `pnpm --filter @zeus-ecosystem/ai-host dev`（端口 8788）。除 `/health`
外每个端点都要 Bearer token；未配置 `ZEUS_AI_TOKENS` 时全部 401（fail closed）。
Node 22.13 之前 `node:sqlite` 需要 `--experimental-sqlite`；仓库的测试入口已用
`run-with-sqlite.mjs` 处理。

**构建与验收。** 没有 `build` 脚本，产物用 `bundle`（esbuild 单文件
`dist/server.js`，保留 `node:` 前缀）；单测 27 项；CI 里有协议验收 9 项（含真实进程
重启）。

**地址。** 不公开。只有 workbench 容器通过 compose 网络访问它。

**部署方法。** 随 `ai` 单元一起升级，不单独发布。`/health` 同时报告
`mode / publicReplay / readOnly / interactive`，workbench 据此渲染只读态。

### Playground — `apps/playground`

**演示什么。** 开发者 Playground：CodeMirror 6 编辑器 + 在 Worker 里跑的 Rust 编译器
WASM 构建、分栏预览、用户代码的 **opaque-origin 沙箱**、Native 与 WebC 两个产品、
IndexedDB 持久化与分享链接。它是唯一运行不可信代码的应用。

**Zeus 包。** 8 个运行时包：`@zeus-js/compiler-wasm@0.1.1-beta.20`、
`playground-engine@0.2.0-rc.5`，以及 `zeus`、`runtime-dom`、`signal`、`router`、
`query`、`i18n`（均 `0.2.0-rc.5`）；构建期 `@zeus-js/vite-plugin@0.0.6`。
零 `@zeus-web/*` 依赖。

**启动与构建。**

```sh
pnpm --filter @zeus-ecosystem/playground dev     # 实测 index 与 sandbox 均 200
pnpm --filter @zeus-ecosystem/playground build   # 四个入口 + 1.55 MB wasm
```

本地开发自动把 `localhost` 与 `127.0.0.1` 配成两个 origin；生产必须显式给
`VITE_ZEUS_SANDBOX_URL` / `VITE_ZEUS_PLAYGROUND_HOST_ORIGINS`，否则 fail closed。

**构建与验收。** 本地 `tsc --noEmit` 与 `vite build` 通过（index / sandbox / webc /
host 四个入口，wasm 1,551,706 字节）；单测 14 项；CI `Apps build`
通过（run `45829154399`，commit `1551b25`，并断言 `sandbox.html` 资源路径为相对路径）。
**镜像构建失败**（run `45829174209`，`Image / playground`）：Dockerfile 仍按 core
仓库布局 `COPY Cargo.toml`、`crates/`、`packages/`、`examples/playground-editor`，
这些路径在本仓库不存在。镜像级验收因此一项都没有。

**地址。** 两个都**不是**本仓库的产物：

- 生产 <https://playground.moonbyte.top:8443/>（200）：`build-info.json` 是
  `0.2.0-rc.5`、构建于 2026-11-23，由 `zeus/playground-image.yml` 构建；
- Pages <https://baicie.github.io/zeus-playground/>（200）：构建于 2026-11-26，
  由 `zeus/playground-pages.yml` 从 `examples/playground-editor` 构建。

**部署方法。** `products.json` 已登记 `playground` 产品：端口 80、`sandboxPort: 81`、
健康路径 `/`、体积预算 210 MiB，`deploymentUnit: "playground"`。但
`deploymentUnits` 里**没有** `playground` 条目，所以
`deployment-plan.mjs --unit playground` 直接报 `unknown deployment unit`。
发布载体 `apps/playground/deploy/docker-compose.deploy.yml` 存在，但它拉的是
`ghcr.io/baicie/zeus-playground` —— **由 zeus 仓构建的那个镜像**，不是本仓库的产物；
它的注释也仍指向 `examples/playground-editor/docker-compose.yml` 与
`.github/workflows/playground-image.yml`。照它部署会部署线上旧实现。

## 3. Demo（尚未迁入，`demos/` 目录不存在）

候选都还在 `baicie/zeus/examples/`。分类的权威结论在 zeus 仓的
`docs/architecture/r19-demo-classification.md`（P11，基线 `ddae9d95`）：
十个"复杂目录"里 **app 0、demo 3、fixture 3、wrapper 4**，
去向是 ecosystem demos 5、留 core 3、retire 2。

共同点（逐项实测）：**都没有 Dockerfile**、**都没有 `test` 脚本**、
**都没有浏览器门禁**、**都没有可访问的 demo URL**（逐个探测 404）、**都不部署**。
本地 `vite build` 全部通过（2026-11-26 实测）——"能构建"不等于"被验证过"。

| 目录 | 分类 | 演示什么 / 实际是什么 | Zeus 包 | 启动（在 zeus 仓） | 迁入障碍 |
| --- | --- | --- | --- | --- | --- |
| `project-board` | **demo** | 935 行的单页看板（主体是 524 行 `main.tsx`）：对象 `class={{…}}`、`consumes` + Provider bridge、`defineElement` + `emits`、Show/For/Host/Slot 同树；无路由、无持久化、无网络 | `@zeus-js/zeus` | `pnpm example:project-board` | 先补一个 core 契约用例，否则迁走的是这几项能力唯一的"同树"证据 |
| `headless-demo` | **wrapper** | 96 行；14 行 `main.tsx` 注册 WC，声明 4 个 Zeus 依赖但只 import 1 个（另 3 个是死依赖） | `@zeus-ui/headless`（实际） | `pnpm example:headless-demo` | `@zeus-ui/headless` 是 private fixture，npm 上不存在 |
| `use-headless-cli` | **wrapper** | 307 行；`zeus-ui add button` 的 scaffold 产物，Tailwind 真正生效 | `@zeus-ui/headless` | `pnpm example:use-headless-cli` | 同上；且已落后于当前 CLI 输出，迁移前要重生成 |
| `use-headless-react` | **wrapper** | 401 行；13 个 headless 组件，两页用 `useState` 切换；JSX 由 `@vitejs/plugin-react` 编译，Zeus 编译器不参与 | `@zeus-ui/headless/react` | `pnpm example:use-headless-react` | 同上 |
| `use-headless-vue` | **wrapper** | 394 行；与 React 版逐组件同构 | `@zeus-ui/headless/vue` | `pnpm example:use-headless-vue` | 同上 |
| `registry-react` | **demo（建议 retire）** | 524 行；`src/` 零 `@zeus-ui/headless` import，5 个组件是手写复刻；无 Tailwind 管线，产物 CSS 757 B 且页面无样式 | 声明了但没用 | `pnpm example:registry-react` | 不是可迁移的演示，是错误示范；两份副本都要处理 |
| `registry-vue` | **demo（建议 retire）** | 290 行；同上，只有 Button/Switch/Checkbox | 声明了但没用 | `pnpm example:registry-vue` | 同上 |

**关键约束。** 本仓库只安装已发布包。上表五个"去 ecosystem demos"的目录里，
除 `project-board` 外都依赖 `@zeus-ui/headless` —— `private: true`，registry 查询 404。
它们不能按原样搬进来；要么发布该 fixture，要么改成消费 `@zeus-web/*` 的公开组件。

**双轨。** 同名的 `headless`、`headless-demo`、`use-headless-*`、`registry-*` 在
`zeus` 与 `zeus-ui` 各有一份且已经漂移（`headless` 46 个文件里 13 个不同，
`registry-react` 14 个里 11 个不同）。对它们"迁移"实际是**去重**：先定正本，
删副本，再谈命名空间（`@zeus-js/*` 与 `@zeus-web/*`）。

**CI。** `examples:check:all`（tsc + `vite build`，零行为断言）跑在
`component-host-rc.yml` 的 `examples/**` 路径上，不在 `ci.yml` 里。
四个 wrapper 与三个 demo 的运行时行为没有任何门禁——`registry-*` 的 Tailwind
缺陷能长期存活正是这条缺口。

**parity 预算。** `parity.test.mjs` 的语料总数 76，守卫是 `> 60`。
上表 7 个目录合计 12 个 `.tsx`，迁走后余量 4；`playground-editor`（4 个）一迁
正好 60，守卫立刻变红。所以任何移动都必须在同一提交里改
`expectedCorpusCounts`。

## 4. 不在本仓范围内的

- `zeus-ui/examples/*-showcase`、`zeus-ui/apps/docs`：组件画廊与文档站，是
  `zeus-ui` 的职责，不是本仓库的应用或 Demo。
- `zeus/examples/headless`、`next-boundary`、`devtools-panel`：分类为 **fixture**，
  留在 core。`headless` 是 `private: true`、从未发布的库型 fixture（`pnpm
  example:headless` 实测 404），`next-boundary` 是唯一的 Next 宿主，
  `devtools-panel` 是 devtools 协议的可视化测试替身。

## 5. 今日实测到的缺口

以下每条都有可复现依据，写在这里是因为它们正好落在"应用索引"要回答的问题上：

1. **Playground 镜像构建失败。** `apps/playground/Dockerfile` 仍按 core 布局
   引用 `Cargo.toml`、`crates/`、`packages/`、`examples/playground-editor`；
   run `45829174209` 的 `Image / playground` 因此失败，其余三个产品通过。
   同一文件与 `apps/playground/README.md` 里的 `--filter @zeus-js/example-playground-editor`
   也是旧包名，本仓库的包叫 `@zeus-ecosystem/playground`——即使 COPY 修好，下一步仍会失败。
2. **Playground 的部署单元不存在。** `products.json` 给产品写了
   `deploymentUnit: "playground"`，但 `deploymentUnits` 只有 `ai` 与 `admin`；
   `deployment-plan.mjs --unit playground` 报错。产品已登记、单元未定义。
3. **Admin 的部署 compose 与镜像端口不一致。** 镜像 `ENV PORT=8787`，
   `apps/admin/deploy/docker-compose.deploy.yml` 却映射 `8080:8080` 且健康检查打
   8080；照它部署会起得来但永远不健康。
4. **Admin 的 `buildInfoPath` 没有生产者。** `products.json` 声明
   `apps/admin/dist/build-info.json`，但 admin 的 Vite 配置不写该文件（只有
   ai-workbench 写），构建后目录里没有它。
5. **Demo 站点已冻结。** `zeus-demos` 的发布工作流 `demos-pages.yml` 已于
   2026-11-25 从 zeus 删除，本仓库没有任何东西替代它；`baicie.github.io/zeus-demos/`
   仍可访问，但停在那次构建（run `45571032146`）。
6. **本地 compose 文件都指向旧路径。** `apps/admin/docker-compose.yml`
   （`examples/admin/Dockerfile`）、`apps/ai-host/docker-compose.yml`
   （`examples/ai-host/Dockerfile`）、`apps/playground/docker-compose.yml`
   （`examples/playground-editor/Dockerfile`）在本仓库都无法构建；
   CI 用的是各自 `deploy/` 下的释放版（只拉镜像），所以这个缺陷没被 CI 暴露。
7. **README 仍写"Three applications"。** 现在是四个；应用清单以本页为准。

## 6. 相关文档

- 生命周期与每阶段证据：[`migration-checklist.md`](migration-checklist.md)
- 应用迁移台账：[`demo-catalog.md`](demo-catalog.md)
- 兼容性矩阵：[`compatibility-matrix.json`](compatibility-matrix.json)
- 产品与部署单元契约：[`../infra/contracts/products.json`](../infra/contracts/products.json)
- Demo 分类（zeus 仓）：`docs/architecture/r19-demo-classification.md`
