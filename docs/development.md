# 开发与架构

```sh
pnpm install
pnpm run check        # typecheck(host+client) + 单测 + 双 half 构建
```

类型直接来自 npm 的 `@deepseek-ai/*` 包（devDependencies，`pnpm install` 后即可 typecheck）；需要读实现时看公开仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。

客户端 external 只允许 loader 平台模块表条目（`PLATFORM_MODULES` + runtime exemption），与官方 `tsdown.client.ts` 合同一致。

## 两个平面

插件的东西分两层注册，边界是「进不进模型上下文」。

**profile 层**（`cordis.patch.yml`，每个会话都在）：投影、面板前端、`/series` `/control` `/models` 路由、preset 自安装。它们是宿主侧的东西，不进模型上下文也不进会话菜单。

**agent 层**（preset 组合里的两行，只在「算子优化模式」的会话里）：

| preset 行 | 内容 |
|---|---|
| `@xietwim/dsh-kernel-opt/agent` | `kernel_plan` + `kernel_env` + `kernel_finalize` + `/kloop` + `/supervise` |
| `@xietwim/dsh-kernel-opt/self-compact` | `self_compact`——**必须放在 compaction 组内**，因为那个组 `isolate` 掉了 compaction 服务 |

两行都不写配置：profile 半把**解析好的配置**和**唯一一份循环操作面**通过 `kernelOptRuntime` 服务递过去，所以面板的 `/control` 按钮和 `/kloop` 驱动的是同一份状态，且 preset 行自己不持有任何循环状态。插件不在时服务不在，两行干脆不挂载。

## 兼容基线

`@deepseek-ai/dsh` **0.1.0-rc.6**（2026-08-13 公开发布，npm dist-tag `latest`）。

使用 `ctx.webServer` / `ctx.compaction` / `sessionId` 标准 prop，**不兼容 2026-08-11 改名之前的版本**（`httpServer→webServer`、`compact→compaction`）。

### peer 范围为什么是两段式

```
>=0.0.1-rc.2 <0.1.0 || >=0.1.0-rc.2 <0.2
```

因为**宿主有两条版本线**：npm 上的 `0.1.0-rc.N`，以及从源码树跑起来的 `0.0.1-rc.N`（源码树自报 `0.0.1-rc.2`，是改名之后的构建）。

这里必须写成两段——semver 对预发布版本的规则是「只有当某个比较符与它 major/minor/patch 完全相同且自身带预发布标记时才被接纳」，所以把范围直接放宽成 `>=0.0.1-rc.2 <0.2` 反而会把**所有** `0.1.0-rc.x` 排除在外（实测确认）。

两段式同时收下两条线，并排除改名之前的 `0.0.1-rc.1` 与将来的 `0.2.x`。

## CI

`.github/workflows/ci.yml` 跑的就是本地那条 `pnpm run check`（两遍 typecheck + 89 个测试 + 双半构建），外加一步 **`lib/` 是否跟得上 `src/`**。

`lib/` 是提交进仓库的（安装免构建），所以源码改了没重新构建时，每个宿主加载的都还是旧的那一半。**这件事在本仓库真实发生过，连续三个版本只活在 `src/` 里。**
