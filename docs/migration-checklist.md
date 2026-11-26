# 迁移状态与清单

## 状态词汇

单一 `MIGRATED` 布尔值会掩盖后续未完成的工作。每个应用单独记录阶段，每个阶段有它需要的证据：

| 阶段 | 含义 | 需要的证据 |
| --- | --- | --- |
| `SOURCE_MIGRATED` | 代码已迁入，依赖全部是已发布版本 | 契约检查通过，无 `workspace:`/`file:`/alias |
| `LOCAL_TESTED` | 本地 typecheck、单测、构建通过 | 命令输出 |
| `CI_VALIDATED` | 最新 HEAD 上的 CI 绿 | run 链接 |
| `VISUAL_VALIDATED` | 截图与已审查的基准**按像素**比对 | 截图、diff、差异比例、基准提交、人工审查记录 |
| `IMAGE_VALIDATED` | 镜像能构建、启动、回答健康路径 | `delivery-evidence/v1` |
| `DEPLOYMENT_REHEARSED` | 部署计划与回滚被实际演练 | rehearsal 报告 |
| `PRODUCTION_ACCEPTED` | 真实部署已被验收 | 线上证据 |
| `LEGACY_REMOVED` | 旧实现已删除 | 删除的 PR |

## 证据元数据

八级状态回答"这个应用走到哪一步"。另一组标记回答"这条证据本身处于什么状态"，
用来避免把"代码写了"读成"已经生效"：

| 标记 | 含义 | 事实来源 |
| --- | --- | --- |
| `IMPLEMENTED` | 代码在工作区 | 文件 |
| `LOCAL_VERIFIED` | 本机跑通 | 命令输出 |
| `PR_OPEN` | 有 PR 未合并 | GitHub PR |
| `MERGED` | 已合入 main | GitHub PR 状态 |
| `PUBLISHED` | 已发到 registry | npm / OCI |
| `CI_VERIFIED` | 目标 HEAD 的 CI 绿 | Actions run |
| `PRODUCTION_DEPLOYED` | 已部署到生产 | 服务器 |
| `PRODUCTION_ACCEPTED` | 生产验收通过 | 线上证据 |

这些标记不重定义八级生命周期，只是给每条证据加一个"到哪了"。

**禁止用研发报告代替事实来源。** PR 合并状态看 GitHub，CI 看 Actions，发布看
registry，镜像身份看 OCI。本文件里的每一句状态描述都应当能指回其中一处。

## 当前状态

### AI Workbench

| 阶段 | 状态 | 依据 |
| --- | --- | --- |
| SOURCE_MIGRATED | ✅ | 依赖 `0.1.0-beta.35` / `0.2.0-rc.5`，无源码 alias |
| LOCAL_TESTED | ✅ | tsc 干净、8/8 单测、vite build 207 kB |
| CI_VALIDATED | ✅ | `AI Workbench / Browser gates` 与 `AI Apps / Node 22|24` 在 main 上全绿 |
| VISUAL_VALIDATED | ⬜ | 未做。AI 侧没有发布过的参考构建可冻结；见下文 |
| IMAGE_VALIDATED | ⬜ | 曾记为 ✅ 并引用 `delivery-evidence/v1`，但**仓库里没有任何这种文件**。CI 的 `Image / ai-workbench` 绿证明镜像能构建，不满足本表第 13 行要求的证据形式 |
| DEPLOYMENT_REHEARSED | ✅ | AI 单元有自己的 `scripts/release/ai-rehearsal.mjs`（不是 `cross-version-rehearsal.mjs`）。最新通过的报告 15 步全过、两侧镜像 ID 不同、数据跨版本读回 |
| PRODUCTION_ACCEPTED | ⬜ | **迁移后的版本**未部署。但 AI 侧的**旧实现**正在生产上跑——见下方「线上跑的是旧实现」 |
| LEGACY_REMOVED | ⬜ | 旧实现保留 |

**容器内 P0 门禁**是这一行最有力的证据：48 项检查（三引擎 × 16），经 nginx 代理、read-only root、no-new-privileges 运行，全部通过。

### Playground

第四个完整应用。源码已在 `apps/playground`，从发布包构建。

| 阶段 | 状态 | 依据 |
| --- | --- | --- |
| SOURCE_MIGRATED | ✅ | 依赖 `@zeus-js/compiler-wasm@0.1.1-beta.20`、`playground-engine@0.2.0-rc.5` 与六个 `0.2.0-rc.5` 运行时包、`vite-plugin@0.0.6`；零 `workspace:` / `file:` / alias |
| LOCAL_TESTED | ✅ | `tsc --noEmit` 干净；`vite build` 产出四个入口（index / sandbox / webc / host）与 1.55 MB wasm 资源 |
| CI_VALIDATED | ✅ | `Apps build` 在 `1551b25` 上通过：四个 app 的 `tsc --noEmit` 与构建全过，且断言了 `sandbox.html` 的资源路径是相对的 |
| VISUAL_VALIDATED | ⬜ | 未做。core 侧的视觉门禁随应用一起待迁 |
| IMAGE_VALIDATED | ⬜ | `app-images.yml` 的 matrix 已含 `playground`，镜像尚未构建过 |
| DEPLOYMENT_REHEARSED | ⬜ | 未做 |
| PRODUCTION_DEPLOYED | ⬜ | 未部署 |
| PRODUCTION_ACCEPTED | ⬜ | 未验收 |

**源码迁移不等于交付迁移。** 这个应用现在能构建，但没有任何一项交付证据：
没有跑过 CI、没有构建过镜像、没有部署。core 仓库里的
`examples/playground-editor` 仍然存在且仍是线上 Playground 的构建来源——
在 `apps/playground` 通过 CI 并产出过镜像之前，不能删掉它。

**它有两个 origin。** `:80` 是受信 host，`:81` 是 sandbox。沙箱的响应头
`Content-Security-Policy: sandbox allow-scripts` 才是 opaque origin 的来源；
两者部署到同一 origin 会静默失去隔离。`products.json` 里记录为
`sandboxPort` + 说明。

### AI Host

| 阶段 | 状态 | 依据 |
| --- | --- | --- |
| SOURCE_MIGRATED | ✅ | 依赖 `0.1.0-beta.35` |
| LOCAL_TESTED | ✅ | tsc 干净、27/27 单测 |
| CI_VALIDATED | ✅ | `Host protocol acceptance`（9 项，含真实进程重启）在 CI 中 |
| VISUAL_VALIDATED | n/a | 无界面 |
| IMAGE_VALIDATED | ⬜ | 同左：`delivery-evidence/v1` 不存在。协议验收 9/9 是进程级证据，不是镜像证据 |
| DEPLOYMENT_REHEARSED | ✅ | 与 Workbench 在同一次 15 步演练中作为单元启动，顺序 host → workbench |
| PRODUCTION_ACCEPTED | ⬜ | 同左：迁移后的版本未部署，线上的 host 来自旧实现 |
| LEGACY_REMOVED | ⬜ | 旧实现保留 |

### Admin

| 阶段 | 状态 | 依据 |
| --- | --- | --- |
| SOURCE_MIGRATED | ✅ | 30 个依赖全部指向已发布版本 |
| LOCAL_TESTED | ✅ | tsc 0 错误、26/26 服务端测试、vite build 成功 |
| CI_VALIDATED | ✅ | `Admin / Browser gates`（14 场景 × 3 引擎）与 `AI Apps` 全绿 |
| VISUAL_VALIDATED | ⬜ | **结构一致性 8/8**（landmark 与文本重合度对按 digest 固定的参考构建）+ **像素比对 1/8**（`roles`，1.68%，差异全在候选新增的能力矩阵；其余 7 个场景两构建语言不同，不可比，记 `NOT_RUN`）。设计审查未做——那需要人，不是脚本。见下方说明 |
| IMAGE_VALIDATED | ⬜ | 同左：`delivery-evidence/v1` 不存在。跨版本演练 20/20 用的是镜像，但没有留 `delivery-evidence` 记录 |
| DEPLOYMENT_REHEARSED | ✅ | **真实跨版本** 20/20 步，83.6 秒；回滚后数据完好 |
| PRODUCTION_ACCEPTED | ⬜ | 未部署 |
| LEGACY_REMOVED | ⬜ | 旧实现保留 |

## 证据说明

**线上跑的是旧实现。** 这条此前没有被记录，是本轮核查发现的。

`zeus-ui/.github/workflows/ai-workbench-image.yml` 在 push 到 `main` 且命中
`examples/ai-workbench/**`、`examples/ai-host/**`、`packages/ai-*/**` 等路径时触发，
`environment: production`，最后一步是：

```
"${RUN[@]}" compose -f docker-compose.deploy.yml up -d --pull never --remove-orphans --force-recreate
```

compose 里两个服务，容器名 `zeus-ai-host` 与 `zeus-ai-workbench`。

最近一次成功的完整链路（2026-11-24，`16c7dd13`）三个 job 全部成功：

```
success  Build and publish to GHCR
success  Mirror to TCR
success  Deploy
```

构建源是 `examples/ai-workbench/Dockerfile`（该 workflow 第 160 行）。

**这不是「很久以前部署过。」** `16c7dd13` 就是 zeus-ui `main` 当前的 HEAD，
且 `examples/ai-workbench` / `examples/ai-host` 在那之后没有任何改动——
线上跑的就是旧实现的当前状态。

### 这条改变了什么

| 此前写的 | 实际 |
| --- | --- |
| AI 单元「未部署」 | 迁移后的版本未部署，旧实现正在生产 |
| Phase 7「等所有应用 `PRODUCTION_ACCEPTED`」 | 线上有一份**正在服务**的旧实现，删它等于停服，不是删死代码 |
| 「旧实现清理」是删冗余 | 是**替换**：先让迁移版本上线并验收，再下旧版本 |

迁移版本自己的部署链路是另一条：`zeus-ecosystem` 的 `app-images.yml`
**明确不 push 也不 deploy**，`release-candidate` 因此记录 `0/3 image(s) pushed`。
换句话说，两条链路之间没有交接——旧的在跑，新的还没被推上过 registry。

### 回滚意味着什么

对 Admin，`docs/legacy-cleanup-manifest.md` 记录的回滚目标是
`ghcr.io/baicie/zeus-admin:main`（已按 digest 固定）。

**AI 侧没有对应的记录。** 线上正在用的旧镜像来自 `ghcr.io/baicie/zeus-ai-workbench`
与 `ghcr.io/baicie/zeus-ai-host` 的 `main` 标签——标签会移动，所以它不能作为回滚目标。
在切换之前必须先把当前线上镜像按 digest 记下来，否则回滚时不知道回到哪个构建。

**Admin 的跨版本演练是真的跨版本。** 基线是
**Admin 的跨版本演练是真的跨版本。** 基线是
`ghcr.io/baicie/zeus-admin@sha256:faf238d3b701…`（`132c777e`，`0.1.1-beta.20`，
监听 8080），候选是从当前树构建的
`zeus-admin:local`（`2b06744e…`，`0.2.0-rc.5`，监听 8787）。两者映像 ID 相同
时脚本直接拒绝启动。20 步全部通过，包括：基线写用户 → 备份 → 停止并移除 →
候选在同一卷上读到并修改那一行 → 移除候选 → 重启基线 → 读回 candidate 的修改
（`team=upgraded`）与 candidate 新建的行。报告在 `temp/rehearsal/cross-version-*.json`。

**Admin 的视觉比对按 digest 固定参考。** `:main` 是**可变标签**：写这个门禁时
它解析到 `faf238d3…`（`132c777e`，2026-11-11，渲染中文），再拉一次变成了
`dfa60dd6…`（`4a5db055`，2026-11-23，渲染英文）。两次构建的界面语言不同，所以
用标签做基准会把"两个不同构建"报成"界面差异"。门禁现在按 digest 引用，并在
镜像 ID 与基线不符时报 `REFERENCE_MISMATCH` 而不是继续比对。

在该固定构建下，参考与候选的结构一致、字符串重合度低——**这是语言差异，不是
布局差异**。所以比的是 landmark 的种类与顺序，加上字符串重合度。八分类见
`apps/admin/scripts/checks/check-admin-visual.ts` 的 `compare`，其中
`CANDIDATE_ADDED` 记的是候选版本多出的内容（roles 页的能力矩阵与分配表单），
它**不是**回归。

**视觉结论的边界。** 它证明迁移后的页面保住了结构与内容；像素维度在可比的地方
给出了比值。它**不证明"看起来对"**——后者需要人阅读 `apps/admin/temp/admin-visual`
的截图。本轮没有做这一步，`DesignReview` 因此是 `REVIEW_REQUIRED` 而非通过。

**四个维度分开报，不再合成一个布尔值。**
`apps/admin/scripts/checks/visual-dimensions.ts`：

```
Functional  场景还能不能完成
Structural  页面还有没有同样的 landmark，顺序是否一致
Screenshot  像素是否在阈值内
Design      差异是否有意——人的答案，脚本永远不填
```

这四个维度在 `visual-dimensions.ts` 里定义，但**报告里只有 structural 与
screenshot 两维**——functional 与 design 从未被产出。而且 `overallStatus` 被 import
后**零次调用**，通过判定此前只看 `entry.kind`：`roles` 的像素差 1.68% 被判
`REGRESSION`，报告却写 `passed: true`、进程 exit 0。

**已修**：`passed` 现在把 screenshot 维度算进去，`CANDIDATE_ADDED` 是唯一例外（新增
内容必然带来像素差异，结构维度已经说明了它）。四组测试钉住这个谓词。

仍未做的是把 functional 与 design 真正接进报告——那需要把门禁的场景表与浏览器
断言合并，是接线工作，不是措辞。

## 明确的阻塞

**0. 视觉验收：结构 8/8，像素 1/8，设计审查需人工。**

上一次记在这里的"本机无法安装浏览器"是**错的**，现已更正：CDN 不通，但
`cdn.npmmirror.com/binaries/playwright` 可用，`PLAYWRIGHT_DOWNLOAD_HOST` 指过去后
Chromium 143.0.7499.4（正是 lockfile 钉的 build）安装成功，本机可跑真实浏览器。

| 维度 | 状态 |
| --- | --- |
| Functional Parity | ✅ CI 与本地 |
| Structural Parity | ✅ **8/8** 场景，landmark 种类与顺序对 `faf238d3…` 比对 |
| Screenshot Regression | ✅ 已实现并跑通；**1/8** 场景可比，其余 7 个因两构建语言不同记 `NOT_RUN` |
| Design Review | ⬜ 需要人 |

`roles` 是唯一可比像素的场景，1.68% 差异——**不是回归**。diff 图
（`temp/admin-visual/diff-roles.png`）显示差异集中在候选新增的能力矩阵与分配表单，
参考构建那一区域完全没有内容。`compare` 把这类结果记作 `CANDIDATE_ADDED`：
多出内容，没有丢失。

**为什么 7/8 不可比。** 参考构建（`faf238d3`）决定界面的方式与候选不同，且没有
任何外部输入能同时作用于两者：

| 输入 | 参考构建 | 候选 |
| --- | --- | --- |
| `navigator.languages` | 忽略 | 读取 |
| `accept-language` | 忽略 | 读取 |
| 服务端 workspace locale（PATCH API） | 存下但不渲染 | 读取 |
| `localStorage` 每账号键 | 该构建里不存在 | 读取 |

实测：浏览器语言 `en-US` 与 `zh-CN`、服务端 `locale=en` 三种组合，参考构建都渲染
`<html lang="zh-CN">` 与中文标题。**这是两个构建的真实产品差异**，不是 harness
缺陷。门禁在结构判定为 `STRUCTURE_MATCHES_TRANSLATED` 时不给像素数字——跨语言
比对测的是翻译，不是布局。

**这一轮修掉的三个门禁自身缺陷**（都是先报出假答案，再被追到根因）：

1. **参考会话中途掉线**，五个参考截图全是登录卡片（同一 33857 字节），门禁把它当
   设置页比，报出 3 条 `critical` 与 1.68%–4.69% 的"回归"。修复：每页前检查会话并
   重新登录；`pageContent()` 记录 `signedIn` 与 `pathname`；比对前两侧都检查，任一
   不是目标页面就记 `UNUSABLE`，不产出数字。
2. **readiness 等英文标题**，参考构建渲染中文，6 个场景超时后仍抓图。修复：改用
   landmark 计数判就绪，与界面语言无关。
3. **`waitForFunction` 在 tsx 下必然抛错**：esbuild 给具名函数插入 `__name(...)`
   辅助调用，序列化进页面后不存在；改传字符串又被 CSP `unsafe-eval` 拒绝。修复：
   `page.evaluate` 轮询（`evaluate` 内联函数体，不经 `toString()`）。这个缺陷伪装成
   "页面没就绪"，报告写 `page did not become ready`，看起来像产品或环境问题。

三条都有测试守着：`visual-dimensions.test.ts`（`REFERENCE_UNAVAILABLE` 必须是
`INCOMPLETE` 不是 `PASS`）、`check-admin-visual.test.ts`（源码里不得出现英文标题
等待或语言猜测）、`screenshot-diff.test.ts`（8 条，含尺寸不同必须判不可比）。

**0b. Admin 权限的浏览器验收已执行（16/16）。**
`check:permissions` 驱动真实服务器与生产构建，验证：viewer 的 workspace 名称输入与
保存按钮在无障碍树里是 disabled、提示写明只有管理员能改；viewer 的个人语言仍可切换且
真的改变 `<html lang>`；workspace 语言与主题下拉同样禁用（这一条是本轮补的——只禁用
输入框会留下两个保存必然失败的可用控件）；`PATCH /api/settings` 返回 403 且 body 是
`ZEUS_ADMIN_FORBIDDEN` 而非 CSRF；audit/upload/roles 三个页面渲染 403 错误页；viewer
导航不提供这些入口；**管理员侧仍可编辑与保存**（否则"对所有人禁用"也会全部通过）。

**1. AI 侧没有视觉参考，但参考源是可恢复的。**
我之前的结论写错了：AI Workbench 从未以独立镜像发布过，**不等于**没有可信的
参考源。旧实现完整存在于 `zeus-ui/examples/ai-workbench`，最近的改动是 `9c90d0b`
（在 `main` 的祖先链上），`src/` 下有完整的 `byok/`、`composer-dock.ts`、
`highlight.ts` 等。

有效的 Reference 不必须是 npm 或 Docker 发布物。**可信源码 + 可复现构建 + 完整
来源记录**同样成立。取法是 detached worktree 检出那个 commit、恢复当时的 lockfile、
用原始方式构建并启动。

**已经做了。** `apps/ai-workbench/visual-baselines/reference.json` 记录了重建的参考：
`sourceRepository: baicie/zeus-ui`、`sourcePath: examples/ai-workbench`、
`sourceCommit: 4e7e429`，两个基线镜像的 image ID，以及 replay/fixture 的运行时。

状态是 `CANDIDATE` 而不是 `APPROVED`——**没有人比对过迁移后的 Workbench 和它**，
那是人看截图的事，不是脚本填的。记录存在不等于参考被认可。

**2. `@zeus-js/devtools-consumer` 已发布，Admin 已接入。**
`0.1.1-beta.15` 在 npm 上（`latest` 与 `beta` 都指向它——**首次发布无条件占用 `latest`**，
这是 npm 的行为，不是本仓库的选择）。包本身可用：ESM/CJS 双入口、`.d.ts` 与 `.d.cts`、
SLSA provenance 已验证。

面板在 `apps/admin/src/devtools/bootstrap.ts`，四道保证都实测成立：只在
`import.meta.env.DEV` 与 `?devtools` 同时成立时加载、动态 `import()`、失败只记日志、
`main.tsx` 注册 `import.meta.hot.dispose`。生产构建 66 个 chunk 中 0 个包含它。

**但面板挂载是空的。** `main.tsx:84` 的 `render()` 早于 `:86` 的
`bootstrapDevtools()`，首次渲染的 85 个事件在 consumer 安装 hook 之前就发出去了。
旧实现 `examples/admin/src/main.tsx` 是先挂载消费者。HMR 的 dispose 也不可达——
两者都不是自接受边界，编辑它们触发的是整页刷新。**修它要改渲染顺序，属于产品行为
变更，未在本轮做。**

**3. `vite-plugin` 的编译器版本线错配——已解除。** `0.0.5` 硬依赖
`compiler-native@0.1.1-beta.20`，而 rc.5 包依赖 `0.2.0-rc.5`。`0.0.6` 已发布并修掉，
生态仓的应用与 fixture 全部升级，lockfile 重生成后只含 `0.2.0-rc.5`。
`check:vite-plugin-contract` 门禁（zeus#406）仍在，它向插件实际解析到的编译器提问。

**3b. `compatibility-matrix.json` 的证据仍是升级前的。** 该文件的
`scopeNotes.compilerCompatibility` 还描述 0.0.5 时代，`verifiedAt` 与引用的两次 CI
运行都早于 0.0.6 发布。契约检查只校验结构与 tag 身份，不会发现证据日期早于发布。
这一条需要重新取证据，不是改个版本号。

**4. `live` 门禁没有真实凭据。** 运行器、限额、脱敏与配置校验都在
（`apps/ai-workbench/scripts/checks/check-ai-workbench-live.ts`），无凭据时报告
`LIVE_BLOCKED`——既不是通过也不是失败。**不得用 Replay 通过冒充 Live 通过。**

**5. viewer 的页面级权限已实现，服务端边界有浏览器证据。**
viewer 能打开 `/admin/settings`，这是有意的：该页同时承载工作区设置（管理员）与
个人偏好（语言、主题）。修复前的行为是整页可编辑、保存时被服务端 403；现在的行为是
工作区三项控件禁用并说明原因，个人偏好仍可用。audit/upload/roles 在路由器里就拒绝，
渲染 403 错误页。

`check:permissions` 的 16 项断言守着这条边界，其中包括**管理员侧仍可保存**——
一个把控件对所有人禁用的"修复"会通过其余每一项检查，只有这一项能发现它。

## 生产切换 checklist

以下每一步都需要明确授权，本轮全部未做：

1. 确认 `delivery-evidence/v1` 里的 image digest 已由 registry 存储
2. 生成 `deployment-plan/v1`，`environment` 为 production（当前脚本会拒绝）
3. 记录当前线上镜像集作为 `previousImage`
4. 验证数据兼容性，把 `dataCompatibility` 从 `unverified` 改为有依据的值
5. 按 unit 的 `order` 应用：host 先于 workbench
6. 上线验收通过后再移除旧镜像

## Phase 7 删除旧代码的前置条件

- 三个应用全部达到 `PRODUCTION_ACCEPTED`
- 观察期内无回滚
- **AI 单元完成替换，不是删除**：线上当前跑的是旧实现，Phase 7 对它是
  「先上新的、验收、观察，再下旧的」。删除之前必须先把线上镜像按 digest 记录下来，
  否则没有回滚目标（`docs/legacy-cleanup-manifest.md` 只记了 Admin 的）
- 旧实现引用的工作流全部有替代
- `zeus` 与 `zeus-ui` 的框架级测试不再依赖旧实现。`zeus` 侧是 `examples/admin`
  （`vitest.config.ts`）；`zeus-ui` 侧是 `examples/ai-workbench` 与 `examples/ai-host`——
  实测有 12 处阻塞引用，含两个 workflow、`tsconfig.json`、`vitest.config.ts` 与 9 个
  `check-ai-workbench-*` 门禁脚本。`pnpm check:cleanup -- --zeus ../zeus --zeus-ui ../zeus-ui`
  会逐条报出

## 进度口径

单一百分比会把"代码写完"和"生产验收"混成一个数。分四维记录，每维说明
**分子分母各是什么**：

### 工程研发完成度

以 R19 的 A–L 十二项为分母（本轮前已完成的不计入）：

```
已完成并合并或待合并    A（表生成器）、B（契约检查）、D（provenance）、H（CI 收敛）
本轮补齐              F（视觉四维 + 截图比对 + 语言无关就绪）、G（权限模型 + 16 项浏览器验收）
阻塞在授权            B 的发布部分、E 的 AI baseline、F 的人工审查、J 的生产权限
```

结论：**能自主完成的已全部完成**，剩下的每一项都需要本仓库之外的输入。

### 功能与产品验收完成度

| 应用 | 证据 | 缺口 |
| --- | --- | --- |
| Admin | 14 场景 × 3 引擎浏览器；跨版本 20/20；结构一致性 8/8；像素 1/8（可比场景全过）；权限 16/16 | 设计审查（需人）；7 个场景因参考构建语言不同无法像素比对 |
| AI Workbench | P0 / BYOK / CSP 基线；容器 48 项 | 逐项对照旧版；视觉参考仍是 `CANDIDATE` |
| AI Host | 协议 9/9（含真实重启）；与 Workbench 的联合升级已演练 15/15 | 无 |

### 正式交付准备度

- provenance：**168 个包、三个产品各 56/56 已验证**（63 是 #15 时 Admin 单产品的旧数）
- Release Candidate 聚合：**已建**，`check:candidate` 读十二个维度，各给 `PASS` / `INCOMPLETE` / `BLOCKED`。
  当前 `BLOCKED`——两项阻塞都是「只能由人或本仓库之外的授权回答」：
  `design-review`（需要人看截图）与 `production-authorization`（没有生产权限）。
  `INCOMPLETE` 的五项里，`build` 与 `image-delivery` 是同一件事：**没有任何镜像被推送到
  registry**，本地镜像 ID 不是 digest，也就无法做回滚目标。
- 生产切换 runbook：已写，**未执行**；`check:cutover-preflight` 逐条读**九**项前置条件，
  当前 3 项 MET、2 项 UNMET、4 项 UNKNOWN。`UNKNOWN` 不是「大概可以」——
  `tested-backup` 未知意味着切换开始时没有回滚。
- Phase 7 清理：`check:cleanup` 读五项前置条件，当前 `BLOCKED`；
  `vitest.config.ts` 仍包含 `examples/admin/server/**`，且 0 个应用 `PRODUCTION_ACCEPTED`。

### 生产验收完成状态

`PRODUCTION_ACCEPTED`：**0 个应用**。本仓库没有生产凭据，也没有执行过任何生产操作。

这句话说的是**迁移后的版本**。生产上并非空无一物：AI 单元跑的是
`zeus-ui` 部署的旧实现（见「证据说明」第一节）。两者不矛盾，但只看这一句会
以为线上没人用——实际有人在用，只是用的不是这里的东西。

### 聚合的三个判据各守什么

`release-candidate.mjs` 的十二条维度不是清单，而是「这条证据读得出、且读得出的是这个
commit」。三条判据值得单独说，因为它们各自防一种「看起来绿」：

- **跨版本必须真跨版本。** 先查两侧镜像 ID 不同，再查有没有数据越过版本边界。
  只查第一条会放过「两个不同构建、每步都过、但没搬过任何数据」的运行——那是重启，
  不是升级。两种报告族的字段拼写不同（`imageId` / `imageIds`），只认一种会把另一种
  报成「没记录镜像」。
- **门禁计数按各自形态读。** 四类报告四种形状；一条规则会把 14 场景的浏览器运行
  读成「14 项，低于 42」，把 8 场景的视觉运行读成 0。
- **空维度列表不是 READY。** `[].every(...)` 为真，这个仓库已经因此产出过一次
  「跑了零个门禁却报成功」。现在实现与测试都钉死为 `INCOMPLETE`。

### 旧实现清理完成度

已删三个 workflow（本轮）。旧应用源码、`check:admin`、视觉参考提交**全部保留**，
因为删除条件依赖前三维完成。
