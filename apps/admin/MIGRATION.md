# Admin 迁移记录

从 `zeus/examples/admin` 迁入 `zeus-ecosystem/apps/admin`，依赖全部换成已发布版本。

## 依赖

| 来源 | 迁移前 | 迁移后 |
| --- | --- | --- |
| `@zeus-js/*`（6 个） | `workspace:*` | `0.2.0-rc.5` |
| `@zeus-web/*`（25 个） | `0.1.0-beta.34` | `0.1.0-beta.35` |
| `@zeus-web/dialog` | `file:../../vendor/zeus-web-dialog` | `0.1.0-beta.35`（已发布） |
| `@zeus-js/vite-plugin` | `workspace:*` | `0.0.6` |
| `vite` | `catalog:` | `8.3.8` |

25 个 UI 包在 beta.35 上逐一核对存在。

## 移除的 vendored dialog

`file:../../vendor/zeus-web-dialog` 指向的是一个本地副本。核对后确认：**vendor 目录里的版本号本身就是 `0.1.0-beta.35`**，与已发布版本相同，所以不需要它。

改用 `@zeus-web/dialog@0.1.0-beta.35`。旧仓库的 vendor 目录保留未删。

## 已发布包的四处置配

`@zeus-web/dialog` 与 `@zeus-web/toast` 的 `Props.ref` 接受 `(element: HTMLElement | null) => void`，而 Admin 用 `withRef<DialogElement>` / `<ToastElement>`。ref 回调参数是逆变的，更窄的类型不能赋给更宽的类型。

最小复现：

```tsx
type DialogElement = HTMLElement & { show(): void }
<zw-dialog {...withRef<DialogElement>(() => {})} />   // TS2322
<zw-dialog {...withRef<HTMLElement>(() => {})} />     // ok
```

四处（dialog、toast、input、data-grid）改为 `withRef<HTMLElement>` 并在回调内窄化。窄化安全的原因和原来的类型声明相同：标签就是 `zw-dialog`，到达的元素必然是它。

## 已迁移：devtools consumer

`@zeus-js/devtools-consumer` 已在 npm 上，当前是 `0.1.1-beta.15`，ESM/CJS 双入口、
`.d.ts` 与 `.d.cts` 齐全、SLSA provenance 已验证。它**不是** `private: true`，也不在
32 个发布组内——它有自己的版本线。

原代码在 `import.meta.env.DEV` 且 URL 带 `?devtools` 时动态加载它。迁移后由
`src/devtools/bootstrap.ts` 做同样的事，三道保证都在：

1. 只在 `import.meta.env.DEV` 与 `?devtools` 同时成立时加载，动态 `import()`
2. `main.tsx` 在 `import.meta.hot.dispose` 时调用 `teardown()`，重复挂载不会叠加
3. 生产构建里是死代码——实测 66 个产物 chunk 中 0 个包含它的模块标记

**实测到的三处不足**（都不是加载守卫本身的问题）：

- 冷加载时面板是空的：`render()`（`main.tsx:84`）早于 `bootstrapDevtools()`
  （`:86`），首次渲染的 85 个事件在消费者安装 hook 之前就发出去了。旧实现
  `examples/admin/src/main.tsx` 是先挂载消费者再 `render()`。
- HMR 的 dispose 实际不可达：两者都不是自接受边界，插件也不注入 accept，
  编辑这两个文件触发的是整页刷新。
- 失败路径会泄漏运行时 hook 与 390px 的 `body` padding，因为 `catch` 调用
  `teardown()` 时 `current` 还没被赋值。

## 曾经的阻塞：vite-plugin 的编译器版本（已解除）

迁移时 `@zeus-js/vite-plugin@0.0.5` 硬依赖 `@zeus-js/compiler-native@0.1.1-beta.20`，
而 rc.5 的包依赖 `0.2.0-rc.5`——两个版本并存，插件加载旧的。

`0.0.6` 已发布并修掉了这个错配，`zeus-ecosystem` 的全部应用与 fixture 都已升到它。
插件现在返回 `hmrPlan`，Admin 的 HMR 从整页刷新变成精确到绑定点。

它的平台二进制是 optional dependency，pnpm 在 CI 上按 `supportedArchitectures`
解析到当前平台。重新生成 lockfile 时**必须**带上这个参数，否则只会留下本机平台的
包，Linux runner 上会以另一个原因失败。

## 验证

```
tsc --noEmit        0 错误
vite build          成功，index 254.82 kB / gzip 74.34 kB
test:server         26/26 通过
```
