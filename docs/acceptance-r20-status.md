# R20 — 当前状态

最后更新：2026-11-27。所有状态以真实证据为准，没有证据的一律标为未通过。

## 三仓

| 仓库 | HEAD | 状态 |
| --- | --- | --- |
| `baicie/zeus` | `9353ed74` | CI / Compiler Native Matrix / Release Canary 全绿 |
| `baicie/zeus-ui` | `b7f3997` | 含 Zeus Canary Compatibility 通过 |
| `baicie/zeus-ecosystem` | `bfe1d94` | 见下 |

## 本轮关闭的缺陷

每一条都是先有失败证据，再修，再用同一证据确认。

### A1 — Core HMR lifecycle 多一次挂载

CI 上 chromium 报 12 次挂载、期望 11。计数器自洽（`cleanups = mounts-1`、
`effects = 1`），所以不是 Effect 泄漏。

- `fs.writeFile` 在 Linux 上产生 truncate + write 两个事件，chokidar 看成两次
  修改，Vite 发两次更新 → 改为同目录 rename（单次原子事件）。
- 页面记录 `vite:beforeUpdate` / `afterUpdate` 并按 revision 归因，失败时写
  `temp/hmr-lifecycle-browser/<engine>-<check>-trace.json`。
- 每次写入必须恰好产生一次更新；重复更新是 watcher 缺陷，答案不是放宽范围。

### A2 — Release Canary 缺 wasm target

`canary-dry-run`、`release.yml`、`component-host-rc.yml` 三处都没有
`wasm32-unknown-unknown`；RC precheck 列表本身也缺 `build:wasm`
（compiler-wasm 转公开后 `check:exports` 才开始检查它）。

CI 实证：`Install Rust 1.95 with the wasm target: success` →
`Canary dry run: success`。

### B — UI Canary Compatibility

`check-release-pairing` 在 pin 全为 dist-tag 时**退出 0 并报告配对通过**：
`resolveWorkspaceZeusVersion` 跳过非 semver，回落到常量 `0.2.0-rc.5`。
原测试的 canary 分支读根 `version`，而对齐脚本从不改它，是死代码。

修后拒绝并退 2。main 上的 Zeus Canary Compatibility 通过。

### C — Playground 版本身份

compiler 之前标成 runtime 版本（`wasm:0.2.0-rc.5`，实际 `0.1.1-beta.20`）。
现为单一 `PlaygroundVersionContract`，由 `vite.config.ts` 从 manifest 注入。
10 个测试，含反向测试。

### D — 导出产品缺陷

- WebC 导出入口用 `import * as` 枚举组件，打包器折叠为 `{}`，真实浏览器抛
  `The WebC entry must defineElement()`。改为读 manifest 标签并检查注册表。
- Native 与 WebC 导出共用一个目录，后者删掉前者的树。
- 完整 10 阶段验收通过：下载 → npm 安装 → tsc → build → 浏览器交互。

### E — 运行隔离与失败报告

每次运行独立 `runs/<runId>/`，报告从 `finally` 写出。强制失败验证：
`verdict: FAIL`，阶段 `chromium:editor`，含 commit 与 lockfile 哈希。

### G — Playground 浏览器门禁接入 CI

此前**没有任何** Playground 浏览器门禁接入。补上缺失的 `tsx` 依赖（六个脚本
全是 `tsx <file>`，包内一个都没声明）。浏览器安装必须走 app 的 `--filter`
（根 `@playwright/test@1.57.0` 不支持 ubuntu-26.04）。

### H — 真实镜像安全验收

`check:image` 驱动运行中的部署，11/11 通过。发现并修复：
`frame-src` 钉死生产域名；sandbox URL 缺省时按 `location.port + 1` 推导，
端口映射后必错 → 真实部署**预览完全空白而编辑器一切正常**。

### I — 跨版本演练

`check:upgrade` 三阶段、同 profile、同 origin。13 个断言 12 通过：

- 升级通过：baseline 写的 3 文件项目被 candidate 完整读取、编译、渲染。
- 回滚方向：旧版本读到 candidate 写的 `theme: light` 却显示 `dark`。
  **真实向前兼容缺陷，未修**。

### F — WASM/Engine 契约三层化

15 个能力，三层（compiler / engine / artifacts），7 个必需在 CI 前就跑。
fail-closed 实测：删声明项触发层数下限，删 `record()` 留下未运行项。

### J — RC 聚合按单元选取证据

此前 `newestPassing` 取全局最新，Playground 报告可能被当作 Admin 证据。
现按 `products.json` 的单元选择，并按持久化类型校验证据形态。

### K — 视觉

Playground 从未有过视觉基线（K1 的前提不成立）。建立首个基线，标为
`CANDIDATE`：6 场景、两主题、两语言、窄视口。同镜像重跑 6/6 MATCH。

统一审查页 `pnpm visual:review` 立刻抓到 Admin 的 `roles` 场景：
`CANDIDATE_ADDED`（多了 table 和 form）却被像素阈值判为 `REGRESSION`。
已修正为 `REVIEW_REQUIRED`。

### L — Admin DevTools

`render()` 在 `bootstrapDevtools()` 之前，首次挂载的事件全部丢失。改为
先连接后渲染。`check:devtools` 8/8，关键断言：
**首次挂载 7 个 mount/owner 事件在时间线上**（修复前为 0）。

### M — Examples 归属

`project-board`（524 行 Kanban 应用）迁到 `zeus-ecosystem/demos/`，用发布包
构建，删掉 4 个指向 core 源码的 `paths` alias。新家实测：tsc 通过、
`vite build` 69.67 kB、浏览器渲染出 3 个任务卡且无错误。

parity 语料精确计数 52 → 51。规则写进
`docs/architecture/example-ownership.md`。

### N — 交付身份

Playground 补上 `build-info.json`：app commit、Core/UI 版本与 commit、
lockfile 哈希、Node 版本。`products.json` 声明路径后 `build-image.mjs` 与
provenance verifier 才会读取它。

**这个改动第一次把镜像构建弄红了**，两处都是「配置新增了 build 阶段没有的
依赖」：

- `scripts/release/build-info.mjs` 与 `infra/contracts` 在 `apps/playground`
  之外，而 Dockerfile 只 COPY 了 app。`.dockerignore` 的注释甚至写着 builder
  需要这两条路径。
- `build-info.mjs` 在没有 git 时读 `ZEUS_APP_COMMIT`——这正是容器场景。
  Playground 只在 **runtime** 阶段声明了这个 ARG（给 OCI label 用），
  build 阶段拿不到，于是回落到 `git rev-parse`，而镜像里没有 git 二进制。

修后实测镜像内身份：

```
product  playground
app      43b10523fec8
core     0.2.0-rc.5  bc1d4fc2afaa
ui       0.1.0-beta.35  9c90d0b35062
lock     e3e18090641b65cd
```

并对该镜像跑完整验收 11/11——**给配置加身份，如果镜像不再能跑，那身份没有意义**。
`App images` CI 已转绿。

### N2 — `admin` 的构建身份从未产出，`ai-host` 的身份从未被校验

这一条分两半，两半都是「声明了但没人验证」的同一类缺陷。

**`admin`**：`products.json` 从加入该字段起就声明
`buildInfoPath: apps/admin/dist/build-info.json`，`verify-provenance.mjs`
也确实按这个路径读。但全仓只有 `ai-workbench` 和 `playground` 的 vite 配置
调用 `createBuildInfo`，`admin` 既没有插件、Dockerfile 也没 COPY
`scripts/release`。实测：

```
$ pnpm --filter @zeus-ecosystem/admin build && ls apps/admin/dist/build-info.json
ls: apps/admin/dist/build-info.json: No such file or directory
```

于是 provenance 报告的 `sourceCommit` 恒为 `null`——一个没人读的 null 字段。
补上同一个插件（demo 构建跳过，Pages 产物不是交付物），Dockerfile 补
`infra/contracts`、`scripts/release` 与 build 阶段的 `ZEUS_APP_COMMIT`。
修后同一个命令：

```
"sourceCommit": "bfe1d94845b5e02b2a6d1a442fff34d8318f0e4f",
"lockfileSha256": "e3e18090641b65da…"
```

**`ai-host`**：它没有 `dist`，身份只能来自镜像 label
`org.opencontainers.image.revision`。`build-image.mjs` 一直把这个 label
抄进证据，却从不与本次构建的 commit 比较——label 缺失、为空、或来自陈旧
上下文，都会写出一条看起来像事实的记录。现改为不一致即失败，并抽出
`revisionMismatch()` 使其可在没有 Docker 的环境下测试：5 条断言，含截断
SHA 不得按前缀通过；把判定改成恒 `undefined` 后 4 条转红。

> 注意：本机没有 Docker，镜像层改动由 CI 的 `App images` 矩阵验证。

## 仍开放

| 项 | 状态 | 解除条件 |
| --- | --- | --- |
| Playground 浏览器门禁变绿 | 红 | 需发布含 WebC 修复的 `@zeus-js/playground-engine`；`check:contract` 15/15 已通过，失败点在 `check:editor` 的 WebC 导出 |
| 回滚兼容性 | 真实缺陷 | 需产品决策：是否要求旧版读新版数据 |
| `ai-host` 构建身份 | 已关闭 | 见 N2 |
| N2–N5 的 Registry / Pages / 生产切换 | 未开始 | 需要发布与部署授权 |
| O 的文档整改 | 部分 | 遵循本文 |

## 核心结论

**Playground 可以作为独立官方应用使用**：真实镜像编译、预览、沙箱隔离、
导出安装构建全部通过。**但它的 CI 门禁目前是红的**，原因是依赖的 engine
修复尚未发布——这是发布阻塞，不是产品缺陷。

**跨版本升级路径成立，回滚路径不成立**，后者的具体表现是设置项读不回。
