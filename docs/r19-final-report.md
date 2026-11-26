# Zeus R19 最终报告

> 每一条结论都指向可重跑的证据。没有验证过的写「未验证」；验证得出坏消息的照实写。

生成于 2026-11-26。

## 三个仓库

| 仓库 | HEAD | 说明 |
| --- | --- | --- |
| `baicie/zeus` | `0aa75cc1` | `fix(release): canary 改写版本后重生成包表 (#416)`；`CI` 绿 |
| `baicie/zeus-ui` | `4e7e429f` | 本轮未改动；工作区有两个未跟踪的 `Dockerfile.baseline-*` |
| `baicie/zeus-ecosystem` | `git log -1` | 本轮全部改动落在这里 |

## 一、结论

```
工程实现        12/12 有交付物
独立核查         12 项全部裁决：5 DELIVERED、6 PARTIAL、1 项 DELIVERED 但清单有实质错误
生产验收         0/3  应用 PRODUCTION_ACCEPTED
                但 AI Workbench 的**旧实现**正在生产：zeus-ui 的
                ai-workbench-image.yml 于 2026-11-24 部署成功
Release Candidate  BLOCKED
```

六项 PARTIAL 中，能修的都修了（B/D/F/G/H/L 各修掉至少一处关键缺陷），修不掉的列在第七节。

**能自主完成的已全部完成。** 剩下的每一项都需要本仓库之外的输入：一个 registry
写权限、一个人看截图、一份生产授权、一个能渲染英文的参考构建。

---

## 二、A–L 逐项

裁决来自独立的核查代理——它们各自读文件、跑命令，其中三项推翻了我原本的判断。

| 项 | 裁决 | 依据 |
| --- | --- | --- |
| **A** 包表生成器 | ✅ DELIVERED → 连带修一处流程缺口 | 生成器只重写版本单元格、测试保留、main CI 已恢复。但 refuter 发现 **canary 改写版本后不重生成包表**，导致 `write-package-table.spec.ts` 每次都失败——见下文 |
| **B** vite-plugin 独立版本线 | ⚠️ PARTIAL → 已修 | npm 上 `0.0.6`，SLSA provenance 与 tag 一致，隔离安装的 tarball integrity 与 lockfile 逐字节相符，registry 安装物上 HMR 14/14。但**矩阵脚本钉的还是 `0.0.5`**，其测试断言同一个常量——`check:matrix` 一直绿，验的是旧插件 |
| **C** Admin DevTools | ⚠️ PARTIAL | 四道守卫全部实测成立（devDependency、双重守卫、动态 import、66 chunk 中 0 个含它）。但**冷加载时面板是空的**：`render()` 早于 consumer 连接，85 个事件在 hook 安装前就发出去了 |
| **D** Provenance | ⚠️ PARTIAL → 已修 | 真拉取（56/56 VERIFIED，单包 2.2–10.6 秒，篡改 payload 被 sigstore 拒绝）。但**commit 绑定在 CLI 路径上是死代码**——见下文，已修复 |
| **E** AI 跨版本演练 | ✅ DELIVERED | 15 步全绿，镜像不同、数据真穿越。**但 `sqlite3 .backup` 从未执行过**：镜像里没有 `sqlite3`，记录为 `no-sqlite3` |
| **F** 视觉四维分离 | ⚠️ PARTIAL → 已修关键一处 | 四维度在 `visual-dimensions.ts` 里定义，但报告只产出 structural 与 screenshot 两维；`overallStatus` **被 import 后零次调用**，`roles` 的像素回归仍判 `passed: true`。已接线并加测试 |
| **G** 页面级权限 | ⚠️ PARTIAL → 已修两处 | 权限门槛 16/16 成立。但**个人主题被页面覆盖**、**`<select>` 显示错误值**——两处已修；**逐字输入丢字符未修**，见下文 |
| **H** CI 收敛 | ⚠️ PARTIAL | 审计交付完整（`ci-ownership.md`、`check:admin` 存续并实测阻塞合并）。但**CI 没有收敛**：`Playground Image` 因 TCR 的 100-tag 上限失败，修复 `92c01cdd` 躺在未合并的 `chore/remove-legacy-admin-ci` 分支上；`ci-ownership.md` 的 41/26 断言数无法复现 |
| **I** RC 聚合 | ✅ DELIVERED | 12 维度，`check:candidate` 可重跑 |
| **J** 生产切换准备 | ✅ DELIVERED | 9 项前置条件，`check:cutover-preflight` 不指定镜像与环境 |
| **K** 旧实现清理准备 | ⚠️ DELIVERED 但清单有实质错误 | 脚本零 `rmSync`、五项前置实测。但清单把 AI 旧实现的位置写错了，且漏了它正在生产上跑——见第七节 |
| **L** 文档校准 | ⚠️ PARTIAL → 已修 | 审计指出七类错误陈述：provenance 数字、INCOMPLETE 项数、前置条件条数、devtools「未接入」、AI「未演练」、`IMAGE_VALIDATED` 引用不存在的文件。逐条核实后已改 |

---

## 三、独立核查推翻的六个结论

这是本轮最有价值的部分。六个 PARTIAL 都不是「没做完」，而是**做完了但有一处不成立**。

### D：commit 绑定没有接上

`verifyOnePackage(locked, claims, options)` 接受 `claims` 参数，函数体里从未读取它。
比较逻辑在 `judgePackage` 里，而**只有测试调用它**。

后果：把 build-info 的 `coreCommit` 改成伪造值，CLI 仍然 **PASS 56/56、exit 0**。
模块自己的文档写着「attestation 指明的 commit 与 build 声明的不同即为 INVALID」——
那条保证从未在任何真实路径上执行。

**已修**：验证通过的结果现在过一遍 `judgePackage` 再返回。两条新测试钉住差异
（伪造 commit 必须 INVALID；独立版本线不与 core commit 比较）。修复后真实数据仍
56/56 VERIFIED，证明不是误报生成器。

### C：面板在冷加载时是空的

`main.tsx:84` 的 `render()` 早于 `:86` 的 `bootstrapDevtools()`。首次渲染的 85 个
事件在 consumer 安装 hook 之前发出，快照是 0 owners / 0 components。旧实现
`examples/admin/src/main.tsx` 是先挂载消费者再 `render()`。

同一核查还发现：HMR dispose 实际不可达（两者都不是自接受边界）；失败路径会泄漏
运行时 hook 与 390px 的 `body` padding。

**未修**——改渲染顺序是产品行为变更，不是一处文档修正。已记入 `apps/admin/MIGRATION.md`。

### A：生成器对了，canary 流程没跟上

refuter 确认 A 的 `DELIVERED` 成立：只重写 `cells[3]`、7 条 + 2 条测试都在树里、
`check:package-table` 接线属实、main CI 在 `6e623d5f` 全绿。

但它指出了一件 A 没有覆盖的事：**canary dry-run 在
`write-package-table.spec.ts` 上失败 3/7，而 RC 的 precheck 通过。**

根因是两条契约的读取方式不同：

- `package-table.spec.ts` 通过 `git archive HEAD` 读**提交的源码**——暂存区的改写碰不到它，所以它通过
- `write-package-table.spec.ts` 读**工作树**——`release:version-packages` 把 manifest 改成
  canary 版本后，表还是旧版本，所以它失败

`check:package-table` 在 RC 的 precheck 里，**不在 `CANARY_PRECHECK_COMMANDS` 里**，
这就是缺陷从单测冒出来、而不是从一个离原因更近的检查冒出来的原因。

**已修**（zeus#416）：canary 在版本改写后重新生成包表。是生成不是校验——改写正是
让两者不一致的原因，在那里放 `--check` 会让脚本与自己刚产出的树争吵。

### B：矩阵验的是旧插件

`published-consumer-matrix.mjs:57` 硬编码 `'@zeus-js/vite-plugin': '0.0.5'`，而
`scripts/__tests__/published-consumer-matrix.test.mjs:50` 断言这个值等于 `0.0.5`。

插件早一天就升到了 `0.0.6`，本仓每个 manifest 与 lockfile 都更新了，**唯独这个常量没有**。
所以 `check:matrix` 一直通过，而它实际安装并检验的是没有任何其他地方在用的版本。

断言一个常量等于同一个常量，证明的是常量没变，发现不了它已经错了。

**已修**：常量更新为 `0.0.6`，并加 `checkIndependentVersions` 与
`infra/contracts/published-pair.json` 对照，不一致就拒绝安装。写这个检查时立刻发现
`@zeus-js/devtools-consumer` 根本没被列进去——在任何测试跑之前。

改完后实跑了一次矩阵——这是它第一次真正用 0.0.6：

```
PASS  install published packages
PASS  typecheck published types
PASS  import Core at runtime
PASS  import the compat layer at runtime
PASS  production build
PASS  invoke the published CLI
matrix PASS: 0.2.0-rc.5 + 0.1.0-beta.35 via pnpm
```

`compatibility-matrix.json` 的说明也改写了，但**证据日期仍是旧的**，所以
`scope.compilerCompatibility` 保持 `partial`：改叙述而不动证据日期，等于声称有
不存在的证据。

### F：四维在类型里，两维在报告里

`visual-dimensions.ts` 定义了四个维度，`overallStatus` 的规则也写得很清楚：
任一前三维度回归即失败，`NOT_RUN` 与 `REFERENCE_UNAVAILABLE` 记 `INCOMPLETE`，
未审查的设计记 `REVIEW_REQUIRED`。

但 `check-admin-visual.ts` **import 了 `overallStatus` 却零次调用**。通过判定只看
`entry.kind`。实测后果：

```
roles   kind=CANDIDATE_ADDED   screenshot.verdict=REGRESSION (1.68%)
report.passed = true            进程 exit 0
```

同一份报告，读 `screenshot` 字段的人和读 `passed` 字段的人得到相反答案。

**已修**：`passed` 现在把 screenshot 维度算进去。`CANDIDATE_ADDED` 是唯一例外——
候选有参考没有的内容，像素必然不同，而结构维度已经说明了它。四组测试钉住这个谓词，
包括此前会溜过去的那种组合。

**仍未做**：functional 与 design 两维从未被产出。把它们接进报告需要合并门禁的场景表
与浏览器断言，那是接线工作，不是措辞。

### L：七类失效陈述

文档自己第 36–37 行写着「每一句状态描述都应当能指回事实来源」。审计逐条对照后，
有七处指不回去：

| 陈述 | 实际 |
| --- | --- |
| provenance 63/63 | 168 个包，三产品各 56/56（63 是 #15 时 Admin 单产品的数） |
| `INCOMPLETE` 六项 | 五项（provenance 转 PASS 后没回写） |
| 前置条件八项 | 脚本读九项（同句自己的 3+2+4 就是 9） |
| devtools 面板「还没接」 | aa590b3 就已接入，`MIGRATION.md` 还写着「已迁移」 |
| AI 单元「尚未演练」（三处） | `ai-rehearsal.mjs` 15/15，与那三句同在 aa590b3 |
| `IMAGE_VALIDATED` ✅ 引 `delivery-evidence/v1`（三处） | **仓库里没有任何这种文件**，候选聚合器明说 |
| AI 视觉参考「还没做」 | 已重建并记录，状态 `CANDIDATE` |

第六条最严重：三个应用都标了 ✅，引用的证据文件一个都不存在。已降级为 ⬜，
而不是换个说法继续标绿。

### H：CI 没有收敛，修复挂在未合并的分支上

审计部分交付完整：`docs/ci-ownership.md` 记录了三个仓库的归属，`check:admin` 在
`zeus` 上存续（`package.json:79`）、实测经 ci-gate 阻塞合并。任务明确禁止「为了绿灯
删除关键测试」，这一条守住了。

但「CI 收敛」没有达成：

**`Playground Image` 持续失败，原因不在代码。** 最新失败（`45615118985`）是：

```
denied: The repository zeus123/zeus-playground's tag has reached its limit(100).
```

TCR 的 tag 预算用完了。修复 `92c01cdd`（`fix(ci): stop filling the domestic
registry's 100-tag limit`）**不在 main 上**，只存在于
`chore/remove-legacy-admin-ci` 分支，与另外 7 个提交一起未合并。

而且即使合了，当前状态也需要操作者先删远端 tag 或重建仓库释放槽位——仓库里没有
删 tag 的脚本，也没有授权说明。

**`ci-ownership.md` 的 41/26 断言数无法复现。** 核查解析出的最接近解释是
41 = `gallery-` 出现行数、26 = 画廊块 `expect` 数，两者都不是产品页断言；
文件里「ARIA 覆盖」的说法用 `grep -ci aria` 得到 0。这两个数字需要重新统计或标注来源。

**`check:admin` 的抽取没有发生。** `examples/admin`（3.9M）仍在，
`vitest.config.ts` 仍包含 `examples/admin/server`，仓库里没有 admin fixture。
所以「把 `check:admin` 搬出框架仓」这件事只做了审计与决定，没有做迁移。

### G：两类偏好没有真正分开

权限门槛本身成立：workspace 名称/语言/主题与保存按钮禁用，个人语言可用，
`PATCH /api/settings` 返 403 且是 `ZEUS_ADMIN_FORBIDDEN`。

但：

| 缺陷 | 我的实测 | 状态 |
| --- | --- | --- |
| 个人主题被覆盖 | 页头选 `dark` → 进 Settings → `data-theme` 变回 `light` | ✅ 已修 |
| `<select>` 显示错值 | 存 `dark` → 刷新 → 下拉仍显示 `light` | ✅ 已修 |
| 逐字输入丢字符 | `keyboard.type('ABC')` 只剩 `A` | ❌ **未修** |

前两条的修法：`<select>` 的状态改由 `option` 的 `selected` 承载（元素没有 `value`
content attribute）；`applyTheme` 在读者有个人偏好时直接返回，工作区主题只作为默认值。

第三条我试了三种应用层改法（非受控 input、`ref` 一次性赋值、`Show` 只判定义性），
结果没有变化——**问题在编译器的绑定发射，不在这一个页面**。记为框架缺陷，不在应用层
绕过：在一个页面绕过的框架缺陷，仍然是框架缺陷。

`fill()` 一次性赋值，所以门禁从未看见它。这是我那个 16 项权限门禁的盲区。

---

## 四、Release Candidate

`npm run check:candidate`

```
PASS        published-pair             Core 0.2.0-rc.5 (bc1d4fc2) + UI 0.1.0-beta.35 (9c90d0b3)
PASS        contracts-in-sync          3 manifest(s) agree with the pair
INCOMPLETE  build                      no delivery evidence for ai-workbench, ai-host, admin
PASS        browser-gates              admin 14 / permissions 16 / visual 8 / P0 72 / BYOK 69 / CSP 5 / host 9
INCOMPLETE  unit-tests                 no run recorded
INCOMPLETE  visual                     1/8 scenario(s) compared pixels; design review not performed
BLOCKED     design-review              only a person can approve a visual difference
PASS        cross-version              both units read data across the version boundary
PASS        provenance                 168 package(s) across 3 product report(s)
INCOMPLETE  image-delivery             0/3 image(s) pushed
INCOMPLETE  data-compatibility         not established
BLOCKED     production-authorization   no production access
```

**verdict: BLOCKED**

两项 BLOCKED 都是本仓库之外的事：`design-review`（需要人看截图）、
`production-authorization`（没有生产权限）。

六项 INCOMPLETE 里，`build` 与 `image-delivery` 是同一件事：**本仓库的镜像从未推送到
registry**。没有 `--push` 时 `build-image.mjs` 只记 image ID 不记 digest，而本地 ID
无法作为回滚目标。

---

## 五、阻塞与谁能解除

| 阻塞 | 解除方式 | 谁 |
| --- | --- | --- |
| 镜像无 digest | `build-image.mjs --push` | registry 写权限 |
| `design-review` | 看 `apps/admin/temp/admin-visual/` 的截图并写 `approvalStatus: APPROVED` | 一个人 |
| `production-authorization` | 本仓库之外的授权 | 你 |
| `tested-backup` | 生产主机上的恢复演练 | 有主机访问权的人 |
| `previous-image-set` | 从生产主机读当前镜像集 | 同上 |
| `data-compatibility` | 证据或明确保持 `unverified` | 需要实测 |
| 7/8 场景像素不可比 | 一个能渲染英文的参考构建 | 重建基线的工作 |
| `vitest.config.ts` 仍引用 `examples/admin` | 删该 test project | 可自主，但须与 `examples/admin` 一起删 |

**没有一项是「再写点代码就能完成」的。**

---

## 六、这一轮修掉的缺陷

按发现方式分组。前五个是我自己踩的，后十二个是独立核查找出来的。

### 我自己踩的

1. **参考会话掉线** → 五张参考截图都是登录卡片（同一 33857 字节），门禁报出 3 条假 `critical`
2. **就绪等待用英文标题** → 参考构建渲染中文，6 个场景超时后仍抓图
3. **`waitForFunction` 在 tsx 下必挂** → esbuild 插 `__name`，改字符串又撞 CSP
4. **fixture lockfile 没跟上 `vite-plugin@0.0.6`** → npm 绿而 pnpm 红
5. **提交信息被 shell 吃掉反引号** → 已用一个说明提交更正，未 force-push

### 独立核查找出来的

6. **provenance 的 commit 绑定是死代码** → 已修，两条测试钉住
7. **`<select>` 显示错误值** → 已修
8. **个人主题被工作区主题覆盖** → 已修
9. **`overallVerdict([])` 返回 `READY`**（`[].every()` 为真）→ 已修
10. **候选聚合读不到 provenance 报告**（找 `temp/provenance-report.json`，实际是 `per-product`）→ 已修
11. **清理检查放宽了清单定义**（搜全树 vs 清单原话的两行）→ 已修
12. **矩阵脚本钉着 `0.0.5`，其测试断言同一个常量** → 已修，并加契约对照
13. **`overallStatus` 被 import 后零次调用** → 视觉门禁的通过判定不看截图维度，`roles` 的像素回归仍判 `passed: true`。已接线
14. **canary 改写版本后不重生成包表** → `write-package-table.spec.ts` 每次 canary 都失败。已在 canary 流程里加生成步骤（zeus#416）
15. **清理检查把「读不到」报成「干净」** → `?? []` 让 UNKNOWN 分支不可达。已修
16. **`ci-ownership.md` 的 41/26 不是断言数** → 41 是 `gallery-` 出现次数，26 对不上任何东西。已改成实测表述
17. **文档七类失效陈述** → provenance 数字、INCOMPLETE 项数、前置条件条数、devtools「未接入」、AI「未演练」、`IMAGE_VALIDATED` 引用不存在的文件、AI 视觉参考「还没做」

---

## 六点五、清理清单的两个实质错误

K 的核查发现清单本身有两处会让 Phase 7 删错东西的事实错误。都已核实。

### AI 旧实现的位置写错了

清单写 `examples/ai-workbench` 在 `zeus`，并在 per-repository split 里说
`zeus-ui`「nothing to delete」。

实测：`zeus` 从未有过 `examples/ai-workbench`。真正的旧树在
**`zeus-ui/examples/ai-workbench`**（30 个跟踪文件）与 `zeus-ui/examples/ai-host`，
且 `zeus-ui/vitest.config.ts:330` 与 7 个 `check:ai-workbench-*` 脚本仍依赖它。

`LEGACY_PATHS` 把 `examples/ai-workbench` 挂在 `zeus` 下，永远扫不到。

**照这份清单执行 Phase 7，只会删 `examples/admin`，AI 侧旧树没有任何前置条件覆盖。**

### AI 旧实现正在生产上跑

这是本轮最需要你知道的一条。

`zeus-ui/.github/workflows/ai-workbench-image.yml` 的最新运行 `45359330517`
（2026-11-24）三个 job 全部成功：

```
success  Build and publish to GHCR
success  Mirror to TCR
success  Deploy          ← Rolling update containers
```

构建源是 `examples/ai-workbench/Dockerfile`（workflow 第 160 行）。

而生态仓 `apps/ai-workbench` 的 `app-images.yml` **不 push 也不 deploy**，
`release-candidate` 记录 0/3 镜像已推送。

所以 AI 侧不是「观察期还没开始」，而是**线上跑的就是旧实现**。清单的
「不能删除」表只记了 Admin 的回滚镜像，漏了这一条。

我先前在报告里写「三个应用都没有生产部署」，这是错的：迁移后的三个应用都没有
部署，但 AI 侧的**旧实现**已经部署了一年多。

### 清单自相矛盾

顶层表把 `examples/admin/` 整体标为「Delete with Phase 7」，而
「What cannot be deleted yet」说 `examples/admin/server` 因 `check:admin` 必须保留。
`check:admin` 硬 import `examples/admin/server/{auth,index}` 并构建 `examples/admin/dist`。

「删除 examples/admin」与「check:admin 保留」不能同时成立。Phase 7 之前必须二选一。

### 工具的两处死代码

- `build-config-clean` 的 `UNKNOWN` 分支不可达：`?? []` 让 `references` 永不为
  `undefined`，所以 `--zeus` 指向不存在的路径也报 `MET`——与文件头「an unread tree
  is not a clean tree」相反。
- 因 `production-accepted` 恒不到 `MET`、`observation-window` 恒为 `UNKNOWN`，
  `overallCleanup` 的 `READY` 分支不可达：这个工具**在结构上不可能报 READY**。

## 七、留下的、明确不修的

诚实列出比粉饰有用。

| 项 | 为什么不修 |
| --- | --- |
| 面板冷加载为空 | 改 `render()` 与 devtools 的先后是产品行为变更，不是修 bug |
| HMR dispose 不可达 | 需要插件注入自接受边界，属于 `zeus` 仓库 |
| 逐字输入丢字符 | 编译器绑定发射问题，不在应用层绕过 |
| `sqlite3 .backup` 从未执行 | 基线镜像没有 `sqlite3`；要执行得先改镜像 |
| provenance 无 CI 入口 | 需要网络与 token，未接入任何 workflow |
| 报告产物不入库 | `temp/` 被 gitignore；`PASS` 是本机状态而非仓库证据 |
| AI 旧实现正在生产 | 见下方「清单的两个实质错误」 |
| `compatibility-matrix.json` 的证据日期 | 引用的是 0.0.6 发布前的运行；改叙述不动证据，所以 `compilerCompatibility` 保持 `partial` |
| `zeus-ui` 的两个 example 仍钉 `0.0.5` | 跨仓改动需要单独的 PR 与推送授权 |

最后一条尤其重要：`check:candidate` 的 `provenance PASS` 读的是本机 `temp/` 里的
报告。新 clone 或 CI 上同一命令会得到 `INCOMPLETE`。

---

## 八、验证方式

```bash
cd zeus-ecosystem && npm run check        # 132/132
cd apps/admin && pnpm test:checks          # 38/38
cd apps/admin && pnpm check:browser        # 14/14（chromium）
cd apps/admin && pnpm check:permissions    # 16/16
npm run check:candidate                    # 12 维度
npm run check:cutover-preflight -- --unit admin
npm run check:cleanup -- --zeus ../zeus
```

### 三个仓库的 CI 实况

`zeus-ecosystem` 全绿。`zeus` 的 `CI` 在 `6e623d5f` 上绿，但 `Playground Image`
因 TCR 的 100-tag 上限失败、`Release Canary` 失败。

`zeus-ui` 的 `Zeus Canary Compatibility` 失败，原因是 peer 依赖——已核实：

```
@antfu/eslint-config 9.0.0 → eslint-plugin-command 3.5.2
  ✕ missing peer @typescript-eslint/rule-tester@"*"
vitepress 1.6.4 → @docsearch/react 3.8.2
  ✕ missing peer search-insights@">= 1 < 3"
```

这些都是**既有问题**，与 R19 的改动无关，但「三仓 main CI 均绿」这句话是错的。
准确的说法是：本轮改动所触及的工作流（`zeus-ecosystem` 的全部、`zeus` 的 `CI`）
是绿的，其余存在与本轮无关的失败。
