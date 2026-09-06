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

开发依赖钉在 `@deepseek-ai/dsh` **0.1.1-rc.2**（npm dist-tag `latest`），两遍 typecheck 都跑在这一版上。

**实测过两端**：`0.1.0-rc.6`（本机 profile）与 `0.1.2-rc.1`（dist-tag `next`，单独跑的隔离安装）——
面板、preset 落盘、评测曲线都对。

**peer 范围比实测区间宽**，这是有意的，但别把两件事混为一谈：范围写的是「我们认为能装」，
实测说的是「我们真装过」。范围同时收下这两条 rc 线之间与之后的**正式版**（`0.1.0`、`0.1.1`、`0.1.2`…
一直到 `<0.2`），以及 rc.6 之前的 `0.1.0-rc.2`…`rc.5`。这些都没测过；如果哪天要缩，缩的是范围不是文档。

使用 `ctx.webServer` / `ctx.compaction` / `sessionId` 标准 prop，**不兼容 2026-08-11 改名之前的版本**（`httpServer→webServer`、`compact→compaction`）。

### 为什么读日志要过一层 `sessionLog()`

0.1.2 删掉了 `session.events` 这个整段读取器，换成 `snapshotEvents(from?, to?)`——不带参数就是同一段读取。
`projection.ts` 的 `sessionLog()` 按宿主实际有哪个来选，因此**一份构建能装进任意一版宿主**。

写成分支而不是抬版本下限，是因为**跑 kernel 会话的机器通常不是编译这个插件的机器**：录像机、集群跳板、别人的
开发机上装的是哪一版并不由我们决定，而插件是按 sha 装的一份 `lib/`。

同一版里的 `ownEvents()` 不能替代任何一个：面板承诺的是**完整历史**的投影，所以 fork 或 replay 出来的会话
必须连继承来的事件一起投影。

### peer 范围为什么是四段式

```
>=0.0.1-rc.2 <0.1.0 || >=0.1.0-rc.2 <0.1.1 || >=0.1.1-rc.1 <0.1.2 || >=0.1.2-rc.1 <0.2
```

semver 对预发布版本的规则是「只有当某个比较符与它 major/minor/patch 完全相同、且自身带预发布标记时才被接纳」，
所以**每一条 `0.1.x-rc.N` 线都得自己占一段**，一段都省不掉。把范围写成 `>=0.0.1-rc.2 <0.2` 反而会把所有
预发布版本全部排除在外（实测确认）。

这个坑真发生过：原来的两段式写法（`>=0.0.1-rc.2 <0.1.0 || >=0.1.0-rc.2 <0.2`）在宿主发布 `0.1.1-rc.1` 那天
就开始**拒绝当时的 `latest`**，而报错只会说 peer 不满足，不会说是预发布规则。**宿主每开一条 `0.1.x` 线，这里就要
补一段。**

四段一起收下的是：源码树自报的 `0.0.1-rc.N`（改名之后的构建）、npm 上的 `0.1.0-rc.N` / `0.1.1-rc.N` /
`0.1.2-rc.N`，**外加落在这些区间里的所有正式版**（`0.0.1`…`0.0.x`、`0.1.0`、`0.1.1`、`0.1.2`…`<0.2`）——
正式版不需要预发布比较符就能进，段与段之间的 `<0.1.1` / `<0.1.2` / `<0.2` 上界只挡下一条 minor。
排除的是改名之前的 `0.0.1-rc.1`、`0.1.2-alpha.N`（alpha 没测过）与将来的 `0.2.x`。

## CI

`.github/workflows/ci.yml` 跑的就是本地那条 `pnpm run check`（两遍 typecheck + 104 个测试 + 双半构建），外加一步 **`lib/` 是否跟得上 `src/`**。

`lib/` 是提交进仓库的（安装免构建），所以源码改了没重新构建时，每个宿主加载的都还是旧的那一半。**这件事在本仓库真实发生过，连续三个版本只活在 `src/` 里。**
