# Zeus R19 最终报告

> 每一条结论都指向可重跑的证据。没有验证过的写「未验证」；验证得出坏消息的照实写。

生成于 2026-11-26。

## 三个仓库

| 仓库 | HEAD | 说明 |
| --- | --- | --- |
| `baicie/zeus` | `6e623d5f` | `release: vite-plugin@0.0.6 (#415)`，main CI 绿 |
| `baicie/zeus-ui` | `4e7e429f` | 本轮未改动；工作区有两个未跟踪的 `Dockerfile.baseline-*` |
| `baicie/zeus-ecosystem` | `4ee359c3` | 本轮全部改动落在这里 |

## 一、结论

```
工程实现        12/12 有交付物
独立核查         9 项已裁决：5 DELIVERED、4 PARTIAL
                 G/H/K/L 四项由我本地实测判定（核查代理未在时限内返回）
生产验收         0/3  应用 PRODUCTION_ACCEPTED
Release Candidate  BLOCKED
```

三项 PARTIAL 都已修掉能修的部分，修不掉的列在第七节。

**能自主完成的已全部完成。** 剩下的每一项都需要本仓库之外的输入：一个 registry
写权限、一个人看截图、一份生产授权、一个能渲染英文的参考构建。

---

## 二、A–L 逐项

裁决来自独立的核查代理——它们各自读文件、跑命令，其中三项推翻了我原本的判断。

| 项 | 裁决 | 依据 |
| --- | --- | --- |
| **A** 包表生成器 | ✅ DELIVERED | `write-package-table.ts` 只重写版本单元格；`check:package-table` 在 precheck 里（`scripts/release.config.ts:118`）；测试保留未删 |
| **B** vite-plugin 独立版本线 | ⚠️ PARTIAL → 已修 | npm 上 `0.0.6`，SLSA provenance 与 tag 一致，隔离安装的 tarball integrity 与 lockfile 逐字节相符，registry 安装物上 HMR 14/14。但**矩阵脚本钉的还是 `0.0.5`**，其测试断言同一个常量——`check:matrix` 一直绿，验的是旧插件 |
| **C** Admin DevTools | ⚠️ PARTIAL | 四道守卫全部实测成立（devDependency、双重守卫、动态 import、66 chunk 中 0 个含它）。但**冷加载时面板是空的**：`render()` 早于 consumer 连接，85 个事件在 hook 安装前就发出去了 |
| **D** Provenance | ⚠️ PARTIAL → 已修 | 真拉取（56/56 VERIFIED，单包 2.2–10.6 秒，篡改 payload 被 sigstore 拒绝）。但**commit 绑定在 CLI 路径上是死代码**——见下文，已修复 |
| **E** AI 跨版本演练 | ✅ DELIVERED | 15 步全绿，镜像不同、数据真穿越。**但 `sqlite3 .backup` 从未执行过**：镜像里没有 `sqlite3`，记录为 `no-sqlite3` |
| **F** 视觉四维分离 | ✅ DELIVERED | 四维度各自独立；结构 8/8；像素 1/8；`DesignReview` 如实为 `REVIEW_REQUIRED` |
| **G** 页面级权限 | ⚠️ PARTIAL → 已修两处 | 权限门槛 16/16 成立。但**个人主题被页面覆盖**、**`<select>` 显示错误值**——两处已修；**逐字输入丢字符未修**，见下文 |
| **H** CI 收敛 | ✅ DELIVERED | `docs/ci-ownership.md` 记录三个仓库的归属；`check:admin` 保留而非机械删除 |
| **I** RC 聚合 | ✅ DELIVERED | 12 维度，`check:candidate` 可重跑 |
| **J** 生产切换准备 | ✅ DELIVERED | 9 项前置条件，`check:cutover-preflight` 不指定镜像与环境 |
| **K** 旧实现清理准备 | ✅ DELIVERED | 5 项前置条件，脚本内**零个 `rmSync`** |
| **L** 文档校准 | ✅ DELIVERED | 四条不一致已修；「本机无法安装浏览器」明确标注为错误并更正 |

---

## 三、独立核查推翻的三个结论

这是本轮最有价值的部分。三个 PARTIAL 都不是「没做完」，而是**做完了但有一处不成立**。

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

按发现方式分组。前四个是我自己踩的，后五个是独立核查找出来的。

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

---

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
| `compatibility-matrix.json` 的证据日期 | 引用的是 0.0.6 发布前的运行；改叙述不动证据，所以 `compilerCompatibility` 保持 `partial` |
| `zeus-ui` 的两个 example 仍钉 `0.0.5` | 跨仓改动需要单独的 PR 与推送授权 |

最后一条尤其重要：`check:candidate` 的 `provenance PASS` 读的是本机 `temp/` 里的
报告。新 clone 或 CI 上同一命令会得到 `INCOMPLETE`。

---

## 八、验证方式

```bash
cd zeus-ecosystem && npm run check        # 129/129
cd apps/admin && pnpm test:checks          # 38/38
cd apps/admin && pnpm check:browser        # 14/14（chromium）
cd apps/admin && pnpm check:permissions    # 16/16
npm run check:candidate                    # 12 维度
npm run check:cutover-preflight -- --unit admin
npm run check:cleanup -- --zeus ../zeus
```

三个仓库 main 的 CI 均绿（`zeus-ui` 的 `Zeus Canary Compatibility` 与 `zeus` 的
`Release Canary` 是**定时任务**，自 11-24 起失败，与 R19 改动无关：一个是
`@typescript-eslint/rule-tester` 的 peer 依赖，一个是发布环境依赖）。
