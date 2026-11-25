# 迁移状态与清单

## 状态词汇

单一 `MIGRATED` 布尔值会掩盖后续未完成的工作。每个应用单独记录阶段，每个阶段有它需要的证据：

| 阶段 | 含义 | 需要的证据 |
| --- | --- | --- |
| `SOURCE_MIGRATED` | 代码已迁入，依赖全部是已发布版本 | 契约检查通过，无 `workspace:`/`file:`/alias |
| `LOCAL_TESTED` | 本地 typecheck、单测、构建通过 | 命令输出 |
| `CI_VALIDATED` | 最新 HEAD 上的 CI 绿 | run 链接 |
| `VISUAL_VALIDATED` | 截图与已审查的基准比对 | 截图、diff、基准提交 |
| `IMAGE_VALIDATED` | 镜像能构建、启动、回答健康路径 | `delivery-evidence/v1` |
| `DEPLOYMENT_REHEARSED` | 部署计划与回滚被实际演练 | rehearsal 报告 |
| `PRODUCTION_ACCEPTED` | 真实部署已被验收 | 线上证据 |
| `LEGACY_REMOVED` | 旧实现已删除 | 删除的 PR |

## 当前状态

### AI Workbench

| 阶段 | 状态 | 依据 |
| --- | --- | --- |
| SOURCE_MIGRATED | ✅ | 依赖 `0.1.0-beta.35` / `0.2.0-rc.5`，无源码 alias |
| LOCAL_TESTED | ✅ | tsc 干净、8/8 单测、vite build 207 kB |
| CI_VALIDATED | ✅ | `AI Workbench / Browser gates` 与 `AI Apps / Node 22|24` 在 main 上全绿 |
| VISUAL_VALIDATED | ⬜ | 未做。AI 侧没有发布过的参考构建可冻结；见下文 |
| IMAGE_VALIDATED | ✅ | `delivery-evidence/v1`：`BUILD_PASS` / `STARTUP_PASS` / `HEALTH_PASS` |
| DEPLOYMENT_REHEARSED | ⬜ | AI 单元尚未演练；`cross-version-rehearsal.mjs` 目前只有 admin 单元 |
| PRODUCTION_ACCEPTED | ⬜ | 未部署 |
| LEGACY_REMOVED | ⬜ | 旧实现保留 |

**容器内 P0 门禁**是这一行最有力的证据：48 项检查（三引擎 × 16），经 nginx 代理、read-only root、no-new-privileges 运行，全部通过。

### AI Host

| 阶段 | 状态 | 依据 |
| --- | --- | --- |
| SOURCE_MIGRATED | ✅ | 依赖 `0.1.0-beta.35` |
| LOCAL_TESTED | ✅ | tsc 干净、27/27 单测 |
| CI_VALIDATED | ✅ | `Host protocol acceptance`（9 项，含真实进程重启）在 CI 中 |
| VISUAL_VALIDATED | n/a | 无界面 |
| IMAGE_VALIDATED | ✅ | 单文件 bundle，`HEALTH_PASS` |
| DEPLOYMENT_REHEARSED | ⬜ | 随 AI 单元一起演练；`cross-version-rehearsal.mjs` 尚无 ai 单元 |
| PRODUCTION_ACCEPTED | ⬜ | 未部署 |
| LEGACY_REMOVED | ⬜ | 旧实现保留 |

### Admin

| 阶段 | 状态 | 依据 |
| --- | --- | --- |
| SOURCE_MIGRATED | ✅ | 30 个依赖全部指向已发布版本 |
| LOCAL_TESTED | ✅ | tsc 0 错误、26/26 服务端测试、vite build 成功 |
| CI_VALIDATED | ✅ | `Admin / Browser gates`（三引擎 33 项）与 `AI Apps` 全绿 |
| VISUAL_VALIDATED | ✅ | 8 个场景对 `ghcr.io/baicie/zeus-admin:main`（`faf238d3`）；见下方说明 |
| IMAGE_VALIDATED | ✅ | `delivery-evidence/v1`，尺寸与平台见该文件 |
| DEPLOYMENT_REHEARSED | ✅ | **真实跨版本** 20/20 步，83.6 秒；回滚后数据完好 |
| PRODUCTION_ACCEPTED | ⬜ | 未部署 |
| LEGACY_REMOVED | ⬜ | 旧实现保留 |

## 证据说明

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

**视觉结论的边界。** 它证明迁移后的页面保住了结构与内容；它不证明"看起来对"。
后者需要人阅读 `apps/admin/temp/admin-visual` 的截图。本轮没有做这一步。

## 明确的阻塞

**1. AI 侧没有视觉参考。** Admin 能比是因为有发布过的历史镜像。AI Workbench
从未以独立镜像发布过，所以没有可信的冻结基准；用当前构建生成基准等于把现在
的样子记录成"迁移前"。这不是没做，是**没有可用的参考源**。

**2. `@zeus-js/devtools-consumer` 从未发布。** `private: true` 的
`0.1.1-beta.14`。已在 `feat/publish-devtools-consumer`（zeus#408）中补上发布
路径与包形状，**但发布本身需要授权**，标记 `PUBLISH_BLOCKED`。Admin 的
`?devtools` 面板要等版本上了 npm。

**3. `vite-plugin` 的编译器版本线错配。** `@zeus-js/vite-plugin@0.0.5` 硬依赖
`compiler-native@0.1.1-beta.20`，而 rc.5 包依赖 `0.2.0-rc.5`。已加
`check:vite-plugin-contract` 门禁（zeus#406），它会向插件实际解析到的编译器
提问它返回什么。修复版本需要发布，同样 `PUBLISH_BLOCKED`。

**4. `live` 门禁没有真实凭据。** 运行器、限额、脱敏与配置校验都在
（`apps/ai-workbench/scripts/checks/check-ai-workbench-live.ts`），无凭据时报告
`LIVE_BLOCKED`——既不是通过也不是失败。**不得用 Replay 通过冒充 Live 通过。**

**5. viewer 的页面级权限未实现。** viewer 能打开 `/admin/settings`，导航也提供
它。这不是迁移回归（框架仓的 `examples/admin` 行为相同），API 确实拒绝 viewer
的写操作。记录为既有产品缺口。

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
- 旧实现引用的工作流全部有替代
- `zeus` 与 `zeus-ui` 的框架级测试不再依赖 `examples/admin`
