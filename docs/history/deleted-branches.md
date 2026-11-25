# 已合并分支删除记录

2026-11-26 删除。所有分支对应的 PR 均为 `MERGED`，内容已在 `main` 中；
下列 SHA 是为了在需要时仍能定位到被删分支的尖端。

## 本地分支（7 个）

| 分支 | 尖端 SHA | 对应 PR |
| --- | --- | --- |
| `ci/published-consumer-gate` | `2831c798e14a4223c07084dc0eb332e7d002d3fd` | #11 |
| `feat/admin-migration` | `70916634b259a7973761feb9e2afe564386e5a83` | 无 PR（内容由 #12–#14 覆盖） |
| `feat/ai-apps-ci` | `c8f1154fdf1be36388b956cf9c491aead1fe92e0` | #13 |
| `feat/ai-workbench-migration` | `65e5e43d67a6d437b5f9e796730aab73c78e1eed` | #12 |
| `feat/published-consumer-fixtures` | `e61d5254c250684eea47546254e2bb80242085f5` | #10 |
| `feat/published-consumer-matrix` | `0426ca97032468959b6f4b693ba8b9ca8944b39d` | #9 |
| `fix/deployment-plan-contract` | `ce2dd1661fe2d9dd1d3249b6cdb1bfce625cad8a` | #14 |

## 远端分支（7 个）

| 分支 | 尖端 SHA | 对应 PR |
| --- | --- | --- |
| `ci/published-consumer-gate` | `2831c798e14a4223c07084dc0eb332e7d002d3fd` | #11 |
| `feat/ai-apps-ci` | `d7b2d950676c651e54cd5a3135bc18048d901047` | #13 |
| `feat/ai-workbench-migration` | `65e5e43d67a6d437b5f9e796730aab73c78e1eed` | #12 |
| `feat/published-consumer-fixtures` | `e61d5254c250684eea47546254e2bb80242085f5` | #10 |
| `feat/published-consumer-matrix` | `0426ca97032468959b6f4b693ba8b9ca8944b39d` | #9 |
| `feat/phase3b-policy-core-consumer` | `25042e80dfb84288e27e6c48a3364d95e8beb97f` | #1 |
| `feat/phase3c-pair-gate` | `61371d60b090d452d1ec1029238fc1b1b2b9b7b1` | #4 |

## 判据

squash 合并会重写提交，`git branch --merged` 与 `git cherry` 都会把已合并的
分支报成未合并。这次用的判据是 PR 的合并状态加上分支内容在 `main` 中的存在性：

- 6 个分支有明确的 `MERGED` PR，且 `main` 的历史里能看到对应的合并提交
- `feat/admin-migration` 没有 PR，它的每个提交内容都是 #12–#14 的真子集
- 删除前逐分支核对过文件内容；差异只出现在**后续 PR 又改过**的文件上，
  那是分支停在旧 base 上的正常现象，不是未合并

`fix/deployment-plan-contract` 的远端分支在合并 PR #14 时已被 GitHub 自动删除，
所以远端清单里没有它。
