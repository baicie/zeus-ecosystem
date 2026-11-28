# 部署基础设施（从 Core 迁入）

产品的生产部署归本仓库。Core 只负责 npm 发布。

## 目录

| 路径 | 内容 |
| --- | --- |
| `infra/deployment/host-validation/` | compose、nginx、生产 layout、env 模板 |
| `scripts/deployment/transaction.mjs` | 部署事务：锁→校验→快照→DB 预检→备份→切换→健康→验收→保留或回滚 |
| `scripts/deployment/acceptance.mjs` | 线上真实 HTTP/浏览器验收 |
| `scripts/deployment/workspace-restore.mjs` | AI 工作区备份恢复事务 |
| `scripts/deployment/layout.mjs` | 拓扑校验、Caddy 断言、trusted root |
| `scripts/deployment/network-policy.mjs` | 地址分类（私网/回环判定） |
| `scripts/deployment/build-info.mjs` | build-info 与 provenance 校验 |
| `scripts/__tests__/deployment/` | 33 个用例，含 SIGKILL 恢复与符号链接逃逸 |

## 命令

```bash
pnpm check:deployment     # 部署模块的全部测试
pnpm check                # 全仓校验（含上面的 33 个）
```

## 与既有脚本的关系

本仓库原有的 `deployment-plan.mjs`（只出计划）、`cross-version-rehearsal.mjs`（演练
升级与回滚）、`ai-rehearsal.mjs`、`cutover-preflight.mjs`（只判定前置条件）都保留，
职责不变。迁入的 `transaction.mjs` 补的是**真正执行**的那一段——它做快照、备份、
切换容器、跑验收，失败时回滚。两者不重叠：preflight 回答"能不能切"，transaction
回答"切了之后怎么退回来"。

## 信任根

`layout.mjs` 的 `TRUSTED_DEPLOYMENT_ROOT = 'infra/deployment'`。它检查的是**文件
是否在受信任目录下**，不是路径本身好看。Core 时期这个常量是字面量 `deploy/`；
迁移时改成具名常量，因为路径变了两次（Core `deploy/` → 本仓库 `infra/deployment/`），
而检查的意图一直没变。

## 测试垫片

`scripts/__tests__/deployment/expect.mjs` 提供 vitest 风格的 `expect`，让迁移来的
spec 保持一字未改。原因写在文件头：机械改写断言把
`expect(fn).not.toThrow()` 变成了 `assert.throws(...).not.toThrow()`，一个会通过的
断言翻转成了永远不会失败的一个。
