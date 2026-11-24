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
| CI_VALIDATED | ⬜ | 未跑过（PR 尚未进入 CI） |
| VISUAL_VALIDATED | ⬜ | 未做；见下文阻塞 |
| IMAGE_VALIDATED | ✅ | 25.9 MB，`containerAcceptance: PASS` |
| DEPLOYMENT_REHEARSED | ⬜ | AI 单元未演练（Admin 已演练） |
| PRODUCTION_ACCEPTED | ⬜ | 未部署 |
| LEGACY_REMOVED | ⬜ | 旧实现保留 |

**容器内 P0 门禁**是这一行最有力的证据：48 项检查（三引擎 × 16），经 nginx 代理、read-only root、no-new-privileges 运行，全部通过。

### AI Host

| 阶段 | 状态 | 依据 |
| --- | --- | --- |
| SOURCE_MIGRATED | ✅ | 依赖 `0.1.0-beta.35` |
| LOCAL_TESTED | ✅ | tsc 干净、27/27 单测 |
| CI_VALIDATED | ⬜ | 未跑过 |
| VISUAL_VALIDATED | n/a | 无界面 |
| IMAGE_VALIDATED | ✅ | 单文件 bundle，健康检查通过 |
| DEPLOYMENT_REHEARSED | ⬜ | 随 AI 单元一起演练 |
| PRODUCTION_ACCEPTED | ⬜ | 未部署 |
| LEGACY_REMOVED | ⬜ | 旧实现保留 |

### Admin

| 阶段 | 状态 | 依据 |
| --- | --- | --- |
| SOURCE_MIGRATED | ✅ | 30 个依赖全部指向已发布版本 |
| LOCAL_TESTED | ✅ | tsc 0 错误、26/26 服务端测试、vite build 成功 |
| CI_VALIDATED | ⬜ | 未跑过 |
| VISUAL_VALIDATED | ⬜ | 未做 |
| IMAGE_VALIDATED | ✅ | 80.4 MB，`containerAcceptance: PASS` |
| DEPLOYMENT_REHEARSED | ✅ | 8/8 步，含数据跨版本保留 |
| PRODUCTION_ACCEPTED | ⬜ | 未部署 |
| LEGACY_REMOVED | ⬜ | 旧实现保留 |

## 明确的阻塞

**1. 视觉验收未做。** 原 `check-ai-workbench-visual.ts` 依赖 zeus-ui 的 showcase 基线与 accessibility 工具，未迁入。迁移一致性比对需要冻结一个旧版 Workbench 作为 reference，而冻结版本本身要有发布记录——这一步没做。

**2. `@zeus-js/devtools-consumer` 从未发布。** `private: true` 的 `0.1.1-beta.14`，不在 32 个发布包内。Admin 里那段是 DEV-only 死代码，已移除。恢复需上游发布。

**3. `vite-plugin` 的编译器版本线错配。** `@zeus-js/vite-plugin@0.0.5` 硬依赖 `compiler-native@0.1.1-beta.20`，而 rc.5 包依赖 `0.2.0-rc.5`。两个版本并存，Admin 因此构建在旧编译器上。等上游出 rc 线版本。

**4. `live` 门禁未迁。** 需要真实网关凭据，且任务禁止引入生产 Secrets。

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
