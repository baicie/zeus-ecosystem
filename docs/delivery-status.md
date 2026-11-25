# 交付状态（R19 §5）

本文件由 `scripts/release/release-candidate.mjs`、`cutover-preflight.mjs`、
`cleanup-preflight.mjs` 的实测结果整理，不手写状态。三个脚本可以随时重跑，
结论以它们的输出为准。

生成时间：2026-11-25，commit `c90ea3b`（PR #17），main 基线 `aa590b3`。

## 一、Release Candidate

`npm run check:candidate`

```
PASS        published-pair             Core 0.2.0-rc.5 (bc1d4fc2) + UI 0.1.0-beta.35 (9c90d0b3)
PASS        contracts-in-sync          3 manifest(s) agree with the pair
INCOMPLETE  build                      no delivery evidence for ai-workbench, ai-host, admin
PASS        browser-gates              admin-browser 14 / permissions 16 / visual 8 / P0 72 / BYOK 69 / CSP 5 / host 9
INCOMPLETE  unit-tests                 no run recorded
INCOMPLETE  visual                     1/8 scenario(s) compared pixels; design review not performed
BLOCKED     design-review              only a person can approve a visual difference
PASS        cross-version              both units read data across the version boundary
INCOMPLETE  provenance                 no report
INCOMPLETE  image-delivery             0/3 image(s) pushed
INCOMPLETE  data-compatibility         not established
BLOCKED     production-authorization   no production access
```

**verdict: BLOCKED**

### 两个 BLOCKED 的原因

| 维度 | 谁才能解除 |
| --- | --- |
| `design-review` | 一个人看 `apps/admin/temp/admin-visual/` 的截图，认可后在 `visual-baselines/reference.json` 写 `approvalStatus: APPROVED` |
| `production-authorization` | 本仓库之外的授权。它没有生产环境访问权，也不会获得 |

### 六项 INCOMPLETE 里，两项是同一件事

`build` 与 `image-delivery` 都源于：**没有任何镜像被推送到 registry**。

`build-image.mjs` 在没有 `--push` 时只记 `imageId`、`imageDigest: null`。这不是
缺陷，是设计——`temp/delivery-evidence-*.json` 从未存在过，因为没有任何一次运行
传过 `--push`。而本地 image ID 无法作为回滚目标，所以切换前置条件里的第一项就是
`UNMET`。

解除方式：

```bash
node scripts/release/build-image.mjs --product admin --tag <version> --push
```

需要 registry 写权限。

### 其余四项

| 维度 | 解除方式 |
| --- | --- |
| `unit-tests` | 从一次绿色 CI 运行聚合时传 `--unit-tests-passed` |
| `visual` | 需要能渲染英文的参考构建；当前参考构建无条件渲染中文，7/8 场景无法比像素 |
| `provenance` | `npm run check:provenance`（需要网络） |
| `data-compatibility` | 需要证据表明旧版本能读新版本写的数据；没有就保持 `unverified` |

## 二、生产切换前置条件

`npm run check:cutover-preflight -- --unit admin`

| 状态 | 条件 | 说明 |
| --- | --- | --- |
| UNMET | `images-with-digests` | 0/1（admin）、0/2（ai）有 registry digest |
| UNMET | `image-delivery-evidence` | 0 个产品有 BUILD + STARTUP + HEALTH_PASS |
| MET | `complete-unit` | 单元与顺序已声明 |
| UNKNOWN | `previous-image-set` | 演练基线是本地镜像 ID，不是 digest |
| MET | `rehearsed` | 数据确实跨越了版本边界 |
| UNKNOWN | `data-compatibility` | 未建立 |
| MET | `browser-gates` | 本地门禁报告通过 |
| UNKNOWN | `browser-gates-on-commit` | 需要 token 读 CI 结论 |
| UNKNOWN | `tested-backup` | 本仓库看不到生产主机 |

**verdict: NOT_READY**

`UNKNOWN` 不是「大概可以」。`tested-backup` 未知意味着切换开始时没有回滚路径。

## 三、Phase 7 清理前置条件

`npm run check:cleanup -- --zeus ../zeus`

| 状态 | 条件 | 说明 |
| --- | --- | --- |
| UNMET | `production-accepted` | 0/3 应用完成 |
| UNKNOWN | `observation-window` | 切换之后的决定，不是文件 |
| MET | `deleted-workflows-gone` | 三个旧 workflow 已不存在 |
| UNMET | `build-config-clean` | `vitest.config.ts` 仍包含 `examples/admin/server/**` |
| MET | `baseline-explainable` | 基线记录了来源 digest |

**verdict: BLOCKED**

清单自身也漂了一处：它列的 `package.json` 里 `example:admin` 脚本已经不存在。
这表明写在文档里关于树的判断会过期，而读树的检查不会。

## 四、三个应用的状态

| 阶段 | Admin | AI Workbench | AI Host |
| --- | --- | --- | --- |
| SOURCE_MIGRATED | ✅ | ✅ | ✅ |
| LOCAL_TESTED | ✅ | ✅ | ✅ |
| CI_VALIDATED | ✅ | ✅ | ✅ |
| VISUAL_VALIDATED | ⬜ 结构 8/8、像素 1/8、设计审查未做 | ⬜ 参考是 `CANDIDATE` | n/a |
| IMAGE_VALIDATED | ✅ | ✅ | ✅ |
| DEPLOYMENT_REHEARSED | ✅ 20/20 真实跨版本 | ✅ 15/15 真实跨版本 | ✅ 随 AI 单元 |
| PRODUCTION_ACCEPTED | ⬜ | ⬜ | ⬜ |
| LEGACY_REMOVED | ⬜ | ⬜ | ⬜ |

## 五、这一轮修掉的四个真实缺陷

按发现顺序，全部是**先产出错误答案、再被追到根因**：

1. **参考会话掉线** → 五张参考截图都是登录卡片（同一 33857 字节），门禁拿它当
   设置页面比，报出 3 条 `critical` 与 1.7%–4.7% 的假回归。
2. **就绪等待用英文标题** → 参考构建渲染中文，6 个场景超时后仍抓图。
3. **`waitForFunction` 在 tsx 下必挂** → esbuild 插 `__name`，改字符串又撞 CSP。
   症状伪装成「页面没就绪」。
4. **fixture lockfile 没跟上 `vite-plugin@0.0.6`** → npm job 绿而 pnpm job 红，
   因为 npm 不读 `pnpm-lock.yaml`。

本轮（I/J/K）又修了四处：

5. **`overallVerdict([])` 返回 `READY`** — `[].every()` 为真。测试断言写 `READY`，
   而注释说不该。
6. **两种镜像集拼写只认一种** — 把 `ai-rehearsal` 报成「没记录镜像」。
7. **四种门禁报告形状用一条规则读** — 14 场景读成「低于 42」，8 场景读成 0。
8. **跨版本只查镜像 ID 不同** — 放过了「没搬过数据」的运行。
9. **清理检查放宽了清单的定义** — 搜全树，把旧应用自己的源码算成阻塞项。

## 六、结论

**能自主完成的已全部完成。** 剩下的每一项都需要本仓库之外的输入：

- 一个 registry 写权限（解除 `build`、`image-delivery`、`image-delivery-evidence`）
- 一个人看截图（解除 `design-review`）
- 生产授权与生产主机访问（解除 `production-authorization`、`tested-backup`、
  `previous-image-set`、`browser-gates-on-commit`）
- 一个能渲染英文的参考构建（解除 7/8 场景的像素比对）

没有任何一项是「再写点代码就能完成」的。
