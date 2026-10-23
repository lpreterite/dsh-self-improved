# dsh-self-improved

DeepSeek Harness 的**长期记忆与自进化插件**（纯本地）。

> 状态：M0–M6 全部完成并部署到真实环境（web profile）。设计/调研文档仅本地保留（见 `.gitignore`）。

## 这是什么

给 DSH 补上"跨会话记忆 + 自进化"两块缺失能力：

- **记忆**：对话后自动提炼要点（事实/偏好/事件/指令）存入本地记忆库；新会话开始前把相关记忆自动注入给模型——AI 从此"记得你"。
- **自进化**：记忆会巩固、遗忘、被纠正；能从成功任务中提炼出可复用的操作流程（技能），画像随对话持续演化。

架构对齐 TencentDB Agent Memory 的四层记忆金字塔（L0 对话捕获 → L1 记忆提取 → L2 场景归纳 → L3 用户画像），但**全部复用 DSH 自有服务**（`ctx.llm` / `session` 事件 / `agent/pre-step` 注入 / `dsh-skill` / `storageDomain`），存储默认纯本地 SQLite（FTS5 + sqlite-vec），不上传任何数据。

## 功能状态（路线图）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 探针：事件捕获 / 召回注入 / 工具注册 / 设置命名空间 | ✅ 验证通过（隔离环境 headless 实测） |
| M1 | 记忆库：SQLite + FTS5 + jieba 分词 + sqlite-vec；L0 捕获落盘；记忆/对话搜索工具 | ✅ 验证通过（单元测试 + headless 集成实测） |
| M2 | 提取管线：`ctx.llm` 提取 L1 + 严格 JSON 校验/兜底 + 去重 + 防重入节流泵 | ✅ 单元测试通过；真实环境已运行 |
| M3 | 召回注入：agent/pre-step 自动注入 + 关键词/向量/混合检索（RRF） | ✅ 单元测试通过 + 端到端实测 |
| M4 | 自进化：L2/L3 归纳（场景+画像版本化）、遗忘衰减、纠正/遗忘工具、技能合成→dsh-skill | ✅ 单元测试通过；真实环境已产出合成技能 |
| M5 | UI/运维：设置面板（自动渲染）+ 随时开关热应用 + `/memory` 命令 + 记忆浏览器 | ✅ 完成并部署真实 Web 环境 |
| M6 | 成长治理（上限/清理）+ 调度模型（夜间回顾/免费维护/启动补跑） | ✅ 完成：治理上限、夜间回顾（默认 22:00）、15 分钟轮仅免费维护、总开关关闭即停全部定时器 |

## 安装

> **0.1.1 起**：包声明了 `dsh.bundle`，**`dsh plugin add` / 插件市场一键安装会自动装配**（dsh 自动注册为 profile layer），**无需再手动改 cordis.patch.yml**。装完重启 dsh 即可。

### 方式一：npm（推荐，市场一键安装同此）

```bash
dsh plugin --profile web add dsh-self-improved
# 或插件市场里搜到 dsh-self-improved 点一键安装
# 装完重启 dsh 即生效（自动装配，无需手动挂载）
```

### 方式二：从 GitHub 安装（源码快照，prepare 自动构建）

```bash
# 1) 一次性环境准备（若报 store 不一致 / 构建被拦截）：
#    - store 指回与 node_modules 一致的目录：
#      pnpm config set store-dir E:\dshPro\.pnpm-store --global   # 或 profile 下 .npmrc 写 store-dir=...
#    - 允许 git 安装的包运行 prepare 构建（pnpm >= 10 默认禁止），在 pnpm-workspace.yaml 加：
#      allowBuilds:
#        dsh-self-improved: true

# 2) 安装（dsh plugin 转发给 profile 的 pnpm；github:owner/repo 拉取仓库快照并自动跑 prepare=tsc 构建 lib/）
dsh plugin --profile web add github:madage/dsh-self-improved

# 3) 重启 dsh 生效（0.1.1 起自动装配；若仍不加载，按下方"手动挂载"补 insert）
```

> 手动挂载（仅旧版本或特殊布局需要）：在 `$DSH_HOME/profiles/web/cordis.patch.yml` 的 insert 列表加：
> ```yaml
> - insert:
>     - id: dsh-self-improved
>       name: dsh-self-improved
> ```

### 方式三：本地开发（file: link）

```bash
# 构建后复制 lib/ + client.js + package.json 到
# $DSH_HOME/profiles/web/node_modules/dsh-self-improved/
# package.json dependencies 加 "dsh-self-improved": "file:node_modules/dsh-self-improved"
# cordis.patch.yml 加 insert（同上）→ 重启
```

### ⚠️ 安装须知：peerDependencies 双实例坑（已定位并实测修复）

**症状**：安装后**新建会话正常，但 resume 旧会话报错**——`deployment:persona already registered`，并提示 "register through that agent's agent.ctx instead"。

**根因（不是插件代码问题）**：pnpm 默认 `autoInstallPeers` 会把插件的 `@deepseek-ai/*` peerDependencies 在 profile 的 `node_modules` 里装成**物理副本**，与 dsh 主程序内嵌的同名包（如 `E:\npm-global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-scope`）成为**两个独立模块实例**。dsh 的作用域（preset / persona 分层）依赖 `Symbol("dsh.scope")` 做身份绑定，双实例导致 persona 注册掉进全局层，撞上 host 层已注册的 `deployment:persona` → resume 失败；新建会话时全局层尚未被占位、第一次注册恰好成功，所以不报错。

**修复（已实测）**：
1. 把 profile 里多余的 `@deepseek-ai/*` 物理副本替换为指向 dsh 主程序内嵌包的 **symlink**（dsh 官方自愈布局 `$DSH_HOME/profiles/node_modules`）；
2. profile 的 `.npmrc` 设 `auto-install-peers=false`（或在 `pnpm-workspace.yaml` 关掉 `autoInstallPeers`），避免 pnpm 再装物理副本。

**给插件使用者的提醒（发布时保留）**：
> dsh-self-improved 的 peerDependencies 会在 profile 下自动安装物理副本，需配合 dsh 自愈 symlink 布局使用，或将 profile 的 `.npmrc` 设 `auto-install-peers=false`。

### ⚠️ 安装须知：duplicate loader entry id（bundle 插件重复装配，启动即崩）

**症状**：dsh **启动直接失败**（窗口一闪即关 / 无法启动），`dsh web --dump-config` 可见同一 `id` 出现两次。

**根因**：声明 `dsh.bundle` 的插件（0.1.1 起本插件、`dsh-plugin-marketplace` 等）会**自动**加入 `dsh.profile.bundles`，其自带 `cordis.patch.yml` 自动 insert 一个 entry；若 profile 层的 `cordis.patch.yml` 里**还手动 insert 了同一个 id** → loader 启动时抛 `duplicate loader entry id` 崩溃。

**修复（已实测）**：把 profile 层 `cordis.patch.yml` 恢复为 `[]`（空）——bundle 插件的装配全部交给 `dsh.profile.bundles`，用户层**不要再手动 insert 任何 bundle 插件的条目**。

**排查口诀**：dsh 启动闪退 → 先跑 `dsh --profile web --dump-config`，数每个 entry id 出现次数，>1 就是这里的问题。

## 配置（完整见设置页）

```yaml
# $DSH_HOME/settings.yaml
dsh-self-improved:
  enabled: true
  modules:
    capture: true
    extract: true
    consolidate: true
    evolve: true
    recall: true
    tools: true
  review:
    enabled: true      # 夜间回顾（每日一次完整进化）
    time: "22:00"      # 可改 HH:MM
```

> 说明：
> - **总开关关闭 = 插件彻底休眠**：停止全部后台定时器（15 分钟维护轮 / 夜间回顾 / 启动补跑），注销 `/memory` 命令与记忆工具；已存记忆数据保留，重新开启即恢复。
> - **调度模型**：15 分钟定时轮只做「提取 + 免费维护」（衰减/治理，不调 LLM）；完整进化（场景/画像/技能）交给夜间回顾（默认 22:00）、启动 60s 补跑与手动 `/memory evolve`。
> - **技能合成查重**（`evolve.skillSynthesis.dedupe`，默认开）：写入前读取存量合成技能、按词面相似度预过滤，让 LLM 三选一——`SKIP`（已有技能覆盖本主题，不写盘）/ `UPDATE`（就地合并进该技能，旧版自动备份到 `<store>/skills-debug/`）/ 全新技能。撞名**永不产生 `-2/-3` 副本**：同内容幂等跳过；异内容保守跳过并落盘 `skills-debug/` 供人工查看。`dedupe: false` 时回退最早的"已存在不覆盖"语义。
> - **存量技能收敛**（P1）：`/memory skills-audit` 让 LLM 对全部合成技能做重复簇聚类（只出报告与计划，不动文件）→ `/memory skills-merge` 干跑预览 → `--apply` 执行合并（保留者就地更新、副本删除，全部旧版先备份）；`/memory skills-report` 查看最近结果。审计报告附带"从未被调用"退役信号——技能调用（`skill-invocation` 注入）以低重要度事件自动入库，长期零调用者即为归档候选。
> - **`/memory` 命令零 LLM**：直接查本地记忆库，建议用命令菜单（敲 `/`）触发；命令声明了 `input`，带参输入也会被命令系统接管，不走模型。
> - 记忆浏览器（设置页「自进化记忆」→「记忆」Tab）可查看/筛选/纠正/遗忘记忆、画像、场景与合成技能。

## 合规声明

- 本插件**架构启发自** [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)（MIT 协议），为**自研独立实现**，与腾讯无隶属关系、非官方出品。
- 本插件与全部依赖组件均为 MIT 系宽松协议，纯本地运行。

## 致谢

本项目在架构与设计上参考了以下开源项目，衷心感谢它们的作者与社区：

- **[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)**（腾讯云）—— 四层记忆金字塔（L0 对话捕获 → L1 记忆提取 → L2 场景归纳 → L3 用户画像）与记忆管理思想，是本插件记忆管线的直接启发来源；
- **[self-improving-agent](https://github.com/pskoett/self-improving-agent)**（作者 **pskoett**）—— OpenClaw 生态中的自我进化技能：从经验中提炼教训、纠正与可复用流程；本插件的自进化模块（记忆巩固 / 遗忘 / 纠正 + 技能合成）以此为设计灵感。

再次感谢以上项目与作者的开源贡献。

## 文档

- `README.md` —— English version
- `README.zh.md` —— 中文版说明（本文件）
- `docs/` 目录（安装/验证清单、测试指南、设计文档、DSH 源码调研）**仅本地保留**，`.gitignore` 已排除，不进版本库

单元测试：`node scripts/test-storage.mjs` / `test-extract.mjs` / `test-recall.mjs` / `test-evolve.mjs` / `test-commands.mjs`（全部 PASS）。

## License

本项目采用 **MIT License**（MIT 系宽松许可证），完整条款见 [LICENSE](./LICENSE)。

MIT 许可的核心内容：

- **授权**：任何人可免费获得本软件及关联文档（"软件"）的副本，并被授予使用、复制、修改、合并、发布、分发、再许可和/或出售本软件的权利；
- **条件**：软件的所有副本或实质性部分必须保留上述版权声明与本许可声明；
- **免责**：软件按"现状"提供，不附带任何明示或暗示的担保（包括但不限于适销性、特定用途适用性及不侵权）；在任何情况下，作者或版权持有人均不对因使用软件产生的任何索赔、损害或其他责任负责。

Copyright (c) 2026 mashao。`package.json` 中 `license` 字段为 `MIT`。
