# Admin 迁移记录

从 `zeus/examples/admin` 迁入 `zeus-ecosystem/apps/admin`，依赖全部换成已发布版本。

## 依赖

| 来源 | 迁移前 | 迁移后 |
| --- | --- | --- |
| `@zeus-js/*`（6 个） | `workspace:*` | `0.2.0-rc.5` |
| `@zeus-web/*`（25 个） | `0.1.0-beta.34` | `0.1.0-beta.35` |
| `@zeus-web/dialog` | `file:../../vendor/zeus-web-dialog` | `0.1.0-beta.35`（已发布） |
| `@zeus-js/vite-plugin` | `workspace:*` | `0.0.5` |
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

## 未迁移：devtools consumer

`@zeus-js/devtools-consumer` 是 `private: true` 的 `0.1.1-beta.14`，**从未发布**，不在 32 个发布包内。

原代码在 `import.meta.env.DEV` 且 URL 带 `?devtools` 时动态加载它——生产构建里是死代码。迁移时移除，因此**不改变任何已发布行为**。

恢复它需要上游发布该包，属于发布决策，不是本仓库能决定的。

## 上游阻塞：vite-plugin 的编译器版本

`@zeus-js/vite-plugin@0.0.5` 硬依赖 `@zeus-js/compiler-native@0.1.1-beta.20`，而 rc.5 的包依赖 `0.2.0-rc.5`。两个版本并存，vite-plugin 加载旧的。

它的平台二进制是 optional dependency，pnpm 默认没有解析，构建时报 `requireNative` 找不到 `.node`。用 `supportedArchitectures` 声明让 pnpm 按当前平台解析后解决。

**这是版本线错配**：vite-plugin 只有 `0.0.5`，没有 rc 线版本。等上游同步之前，这个组合能用但依赖旧编译器。

## 验证

```
tsc --noEmit        0 错误
vite build          成功，index 254.82 kB / gzip 74.34 kB
test:server         26/26 通过
```
