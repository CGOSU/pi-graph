# 会话记录

本文件按日期倒序记录每次工作的完成内容、实际验证和遗留问题；新增记录插入对应日期位置，最新条目在前。不记录敏感信息或未经验证的结果。

## 记录格式

每次记录应包含日期、完成内容、实际执行的验证及遗留问题。

## 会话

### 2026-11-04 — graph动态状态栏

- 完成：以独立展示模块统一工具与命令的开始/完成/失败/取消提示、session操作序号及等待计时；会话切换先失效旧展示和旧client，防止迟到回调污染新状态。行为与边界见[README](../README.md)及[设计决策](decisions.md)。保留用户既有`.pi/role-models.json`及未跟踪运行产物。
- 验证：隔离临时检出中`npm run build`、`node --test dist/tests/activity.test.js dist/tests/package.test.js`（9/9）、`node_modules/.bin/tsc --noEmit`、四个改动TypeScript文件的Biome检查及`git diff --check`通过。包含真实Pi隔离安装/加载、成功结果不变、失败和取消仍抛错、并发完成顺序、跨session迟到结果、等待计时清理与headless无UI访问。独立静态审阅未发现阻塞缺陷。
- 过程：首次测试7通过、2失败，原因是临时检出目录名不为`pi-graph`，触发既有包标签断言；移至同名目录后9项全部通过。首次格式检查发现一处换行，格式化后通过；这些不记作初次验证通过。
- 安装验证：本机安装副本已从本地开发仓库快进同步；其生产依赖不含`@types/node`，因此常规`npm run build`失败，改用既有`node scripts/prepare.mjs`成功生成23个运行模块。展示模块源码与开发构建产物逐字节一致。原生Node直导入口缺少由Pi宿主提供的typebox peer，不作为加载结论；最终用文件式探针`/tmp/pi-graph-dynamic-status/pi-graph/verify-installed.mjs`在隔离Pi profile中实际加载安装副本，locate/inspect及其pending/完成序号检查通过，随后关闭worker并清理临时项目。未触碰FlClash索引。
- 边界：未跑全量测试，未做真实TUI视觉验收或模型请求；交付包含本机安装副本同步，但不reload活动会话或重建真实索引。源码与构建产物就绪不代表运行中实例已加载。

### 2026-11-04 — 独立精确名称通道修复与性能验证

- 完成独立精确名称通道与旧库迁移：原样或大小写折叠的短名/限定名分级召回，保留 Unicode 组合字符，并在候选截断前严格匹配 scope；匹配等级、SQLite schema 和事务机制见[设计决策](decisions.md)。涉及实现 `src/core/names.ts`、`src/core/retrieval.ts` 与 `src/core/store.ts`。
- 新增 3 项精确匹配与 3 项 store 回归，均先在修复前复现失败。验证：`npm run build`；针对性测试 32/32；`npm test` 共 95 项、94 项通过，唯一失败为 production-only 安装测试的 npm cache `EPERM`。以授权权限单独重跑 `npm_execpath=/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js node --test dist/tests/production.test.js` 后 1/1 通过。`node_modules/.bin/tsc --noEmit`、`node_modules/.bin/biome check src/core/store.ts src/core/names.ts src/core/retrieval.ts tests/store.test.ts tests/exact-matching.test.ts` 和 `git diff --check` 均通过；Biome 保留 `tests/store.test.ts` 两条既有 `noNonNullAssertion` warning。全量命令本身曾因权限错误退出，不记作全量命令通过。
- 最终 GraphStore 合成对照使用 baseline `4631e69` 的临时转译模块和当前 `dist`，各自独立临时库；Node 26.11.1 / SQLite 3.54.0 / darwin arm64，无并行测试干扰的 21 次交错热查询。60k symbols：exact 48.176→29.182 ms，mixed compile/cache/route 90.428→62.806 ms，scoped mixed 56.492→29.190 ms；候选集合一致，顺序不要求完全相同。首建 commit 中位 245.111→332.156 ms，数据库 54,472,704→62,115,840 bytes（约 +14%）；旧库迁移 122.187 ms。单 symbol 更新/改名中位数基本不变（62.880→63.234 ms；55.421→55.976 ms）。运行命令 `node /private/tmp/pi-graph-store-final-bench.mjs`，输出见 `/private/tmp/pi-graph-store-final-bench.clean.log`。
- 这些是合成 `GraphStore.search` 数据，不代表端到端或真实仓库收益；索引提升热查询同时增加首次写入时间和数据库体积。本次未触碰真实索引或 Pi 安装副本；需更新正在使用的安装副本并重启旧扩展会话才会在运行中生效。旧库重开迁移受支持；不保证旧版本程序并行写入新名称 schema。

### 2026-11-04 — 精确匹配与查询性能审查

- 当时基于 HEAD `0d69a0a` 的只读审查发现以下问题；这些问题后来由本文件上方的修复记录处理。临时目录脚本在当时的 `dist` 上断言通过：单字符/停用词过滤与空 terms 检查使 `x`、`to`、`$`、`_`、`$a`、`_a`、`X.y` 无结果；`Remote.x` 可召回，但正文含 105 个唯一词、仅命中 `remote`，置信度约 0.55、低于 1.4 门槛，候选被删至只剩 `Remote`。限定名与短名同优先级：80 条正文词 `run`/`cache`/`owner` 命中的干扰符号加 40 个 `runCache` 时，查询 `Owner.runCache and runCache` 丢失目标；干扰项为 39 个时目标居首。`Parser.load` 与 `parser.load` 同分时错误大小写先出；对照中 `readHTTPResponse` 原样查询成功，全小写 `readhttpresponse` 和全大写 `READHTTPRESPONSE` 失败。边界样例还发现组合重音标识符被截断、非 ASCII 大小写归一差异可能漏召回、`scope=src` 的 LIKE 匹配也命中 `SRC/b.ts`。
- 合成性能微基准在 Node 26.11.1 / SQLite 3.54.0 / darwin arm64 上交错运行 21 次热查询。60k 符号下，仅给既有 FTS 名称 lane 增加两表达式索引和名称 ID 预过滤的原型由 51.434 降至 15.422 ms，前 40 个 ID 与顺序一致；它仍受 FTS 语义约束，**不是独立精确匹配通道**，且未计索引建立/写维护成本。普通 FTS 不限 scope 时改按既有 rank 排序由 33.229 降至 21.337 ms，窄 scope（59 条）则由 26.724 升至 87.140 ms；故不能据此统一替换。高连接度节点双向 top-K 索引原型（1.8 万边）由 1.201 降至 0.039 ms，额外索引写成本未测；同分文档测试也显示显式 tie-break 会改变候选，使用 rowid 恢复排序需保留临时排序。
- 复现命令为 `node /private/tmp/pi-graph-exact-audit.TnFmwX/repro.mjs /Users/cgosu/code/JavaScript/pi-graph`；性能命令为 `node /private/tmp/pi-graph-perf-audit.mjs 6000`、`node /private/tmp/pi-graph-perf-audit.mjs 60000` 和 `node /private/tmp/pi-graph-rank-tie.mjs`。这些脚本位于临时目录，不在仓库中。上述是合成查询/SQL 原型，不代表端到端或真实仓库收益。可评估的方向包括独立索引精确名称通道、精确命中与置信度门槛解耦、截断前保留完整限定名及大小写优先规则；均为建议，未实施。本轮执行 `npm run build`（成功）和 `node --test dist/tests/retrieval.test.js dist/tests/store.test.js`（8/8）；未运行全量测试。

### 2026-11-04 — 修复混合检索的名称候选丢失与局部变量挤占

- 完成 `src/core/store.ts` 与 `src/core/retrieval.ts` 修复：名称候选使用有界召回；精确命中排序不再抬高置信度门槛；多概念行为查询用真实 `contains` 关系归并局部变量线索。新增 `tests/retrieval.test.ts`，并扩展 Go 混合查询及精确变量回归。根因和长期检索规则分别记于 [踩坑记录](pitfalls.md) 与 [设计决策](decisions.md)。
- 在 FlClash 现有图索引只读快照 revision 40 上对比修复前后：DNS 混合查询从看不到实现变为找到 `core/singbox/profile/compile.go` 和 `core/singbox/routing/compile.go` 的 `Compile`；资源查询从字段/局部变量结果变为包含 `core/singbox/resources/cache.go` 的 `Store.load`，其局部变量不再占据结果名额。复放前后为同一 revision。
- 验证：`npm run build` 后运行 `node --test dist/tests/retrieval.test.js dist/tests/graph.test.js dist/tests/store.test.js dist/tests/syntax-languages.test.js dist/tests/rust.test.js dist/tests/frameworks.test.js`，45/45 通过；`npx biome check src/core/store.ts src/core/retrieval.ts tests/graph.test.ts tests/retrieval.test.ts` 通过；`git diff --check` 通过。
- 遗留：未运行全量 `npm test`。当前开发仓库改动尚未同步到 Pi 安装副本，因此已运行的 Pi 扩展仍不会得到此修复；未执行安装、部署或 push。

### 2026-11-04 — 修复 Kotlin `open` 属性名导致的语法树级联错误

- FlClash 的 `SingBoxSessionTest.kt` 使用合法 Kotlin 属性 `var open = true`。固定 grammar v1.1.0 将 `open` 当作修饰符后会产生 ERROR，级联把 `Resource` 识别为 enum 并漏掉后续方法/关系，原文件仅得到 11 个符号、8 条关系并带 parse warning。根因是上游 grammar 没把 `open` 纳入可按语境解释的 reserved identifier。
- 对上游 v1.1.0 固定源码应用 `grammars/kotlin-open-identifier.patch`：为 `inheritance_modifier` / `_reserved_identifier` 增加冲突规则并将 `open` 加入 reserved identifiers。用 Tree-sitter CLI 0.25.10 / Emscripten 4.0.10 构建 `grammars/kotlin.wasm`，记录源档案、patch、构建命令与哈希到 `grammars/sources.json`。索引配置从 `syntax-v1` 升至 `syntax-v2`，使旧的符号、类型和 warning 快照在查询时自动重建。
- 新增回归覆盖 `open` 作为属性名及类/方法修饰符、调用关系和旧索引迁移；生产安装测试也解析包含该属性的 Kotlin 文件并要求无 warning。
- 验证：固定 grammar 上游 corpus `tree-sitter test` 22/22；`npm run build`；`npm test` 83/83；`tsc --noEmit`；Biome 对改动 TypeScript 文件无 error；`git diff --check`。FlClash 原始 `SingBoxSessionTest.kt` 未修改，使用更新后的 parser 提取 84 个符号、79 条关系、0 warning，`Resource` 恢复为 class。
- 遗留：尚未更新 `~/.pi/agent/git/github.com/CGOSU/pi-graph` 中正在被 FlClash 使用的安装副本；安装副本的 Kotlin WASM 哈希仍为旧值。需更新该副本并重启 session 才会在 FlClash 实际生效。

### 2026-11-04 — 批量优化 FTS5 文档同步

- `GraphStore.writeSymbols` 原先对每个变更或删除的符号单独执行 FTS5 `DELETE ... WHERE id=?`。因 id 未索引，刷新大量符号时形成重复全表扫描。现在收集移除 ID 后用单条 `DELETE ... IN (SELECT value FROM json_each(?))` 批量清理，再插入更新文档；新增文档不做多余删除。
- 新增 1,400 符号回归，覆盖文档更新、删除、新增、稳定文档保留、带引号 ID、全文查询结果和重开已有数据库。
- 验证：`npm run build`；`node --test dist/tests/store.test.js dist/tests/persistence.test.js`（9/9）；Biome 目标文件检查无错误（显示的 2 个 `noNonNullAssertion` 警告位于未改动的既有断言）；`git diff --check`。本机合成基准：8,000 符号首次/批量更新由 1,751/3,251 ms 降至 30/33 ms；16,000 符号由 7,197/12,628 ms 降至 53/69 ms。FlClash 持久化快照（2,123 文件、93,619 符号、85,215 关系）复制到临时数据库后，写入耗时 849 ms，更新事务完整性、93,619 条全文文档的 id/content 一致性与检索均通过；未改原缓存。
- 范围：测得的 FlClash 数据只验证 SQLite 存储阶段，不覆盖扫描/解析耗时；FlClash 加载的 Pi 安装副本位于 `~/.pi/agent/git/github.com/CGOSU/pi-graph`，当前工作区与安装副本源码不同，因此本次改动尚未作用于正在运行的 FlClash session；需将优化部署到该副本并重启 session 才会生效。

### 2026-11-04 — Dart、Go、Kotlin 语法索引

- 扫描与 worker 支持 `.dart`、`.go`、`.kt`、`.kts`，保留现有 Rust/TS/Vue 管线。Dart/Kotlin 固定 WASM grammar 随包发布、带 MIT 许可证及来源 SHA-256 manifest；Go 使用既有 `@vscode/tree-sitter-wasm` grammar。按语法树提供常见声明、UTF-16源码范围、包含和有限同文件调用；歧义或未知关系不猜，语法错误 warning 表示覆盖不完整。适用边界见 [README](../README.md#实现边界)。
- 验证：`npm run prepare`、`npm run typecheck`、`npm test` 80/80。生产安装回归检查 npm tarball 包含 grammar/manifest/license、生产安装真实加载三种语法、WASM checksum 失败后可恢复；新增语法回归覆盖声明、Unicode/CRLF、局部遮蔽/重载、scope/ignore、worker、增量变更、重命名/删除和旧索引配置迁移。修改文件 `biome check` 无 error，保留 `src/languages/rust-project.ts:388` 一条既有非空断言 warning；`git diff --check` 通过。运行平台为 darwin/arm64 Node v26.11.1，未在 Android 真机验证。
- 未实现编译器级语义、Go package/import 或 Kotlin package/Dart import 跨文件关系、Flutter widget/Android 服务 framework 语义、跨语言调用；相关能力需扩展语法/类型系统后另行验证。

### 2026-11-04 — Android 安装兼容性：Rust parser 改为 WASM

- 移除 `tree-sitter` 与 `tree-sitter-rust` 原生依赖，改由随 `@vscode/tree-sitter-wasm` 包发布的 runtime 与 Rust grammar 初始化 parser。Rust 图配置 hash 升级，旧索引在下次刷新时重建；worker 关闭时释放 WASM parser 与解析树。使用测试检查生产安装依赖中不包含 `.node` addon，并覆盖 grammar 加载失败与恢复。
- 验证：`npm run build`；Rust/production/refresh/persistence 相关测试 22/22；`npm run typecheck`；`npm test` 67/67；改动文件的 Biome 检查（无 error，保留 `src/languages/rust-project.ts:388` 的非空断言 warning）；`git diff --check`。生产安装测试设置 `--os=android --cpu=arm64`，但测试进程实际运行在 darwin/arm64 Node v26.11.1。
- 遗留：没有 Android/Termux 真机验证，亦未验证 Pi 宿主在 Android 可运行。设备上仍需 Node.js >=22.19、`node:sqlite` 及可运行的 pi 宿主。

### 2026-11-04 — 监听刷新与持久化诊断

- 修复扫描/监听排除不一致、重复排队和无变化查询重复读取源码；增加快照核验、监听失效兜底及扫描中变化的有界重试。覆盖 warnings 随事务保存与恢复，旧索引补建，纯诊断变化也推进 revision。实现边界统一见 [README](../README.md#实现边界)。
- 先复现失败：单个 Rust 文件的首次索引后 locate/inspect 累计读取 3 次；同批三次事件加查询重读 4 次；相同 revision 重开后丢失两条 Vue/超大文件警告。回归修复后相同场景分别累计读取 1 次、只额外读取 1 次，警告完整恢复。这是确定性 I/O 计数，不是运行时间、token 或费用基准。
- 验证：受影响测试 26/26；最终 `npm run typecheck`、`npm run lint`、`npm test`、`git diff --check` 均退出 0，全量 67/67（包含隔离 pi 安装、production-only prepare、取消/回滚）。实际重新构建 `dist`；未修改用户安装副本或真实索引。全仓 lint 的两个既有格式问题仅应用格式修正，保留三个既有非空断言 warning。
- 未运行真实项目 benchmark；未知文件系统事件与元数据同时失真的边界见 README。源文件变化仍重建全项目关系，不宣称受影响子图增量或普遍性能收益。

### 2026-10-26 — 增量检索与 worker 取消优化收尾

- 更新 README 与项目记录，说明候选相关性排序、协作取消边界和合成测量；不改变公共工具参数/返回语义。取消在排队、扫描 I/O、同步编译阶段边界和 SQLite 提交前检查；同步编译不可抢占，事务开始后完整提交并发布匹配内存快照。
- 固定输入图的 7 个定位对照中首位目标命中由 3/7 提至 7/7；模型可见正文 11,904→10,979 字符、12,036→11,101 UTF-8 字节，结构化结果 20,122→17,440 字符。展示对照的 3 个匹配样例正文缩短 4%–20.3%。这不是一般项目准确率或计费 token 测量。
- 合成基准在 Apple M6、darwin/arm64、Node v26.11.1 上对 50,103 行、170 文件、5,015 symbols 连续运行 3 次：冷索引中位数 1,246 ms，热查询中位数/P95 为 2/4 ms，单文件更新中位数 244 ms。优化前同口径对照中位数为冷索引 1,252 ms、热查询 4/8 ms、单文件更新 231 ms；只认定合成热查询改善，不宣称冷索引或单文件更新加速。独立 SQLite 提交样本不足以证明稳定显著收益。没有测量真实代理任务 token 或费用。
- 本轮新执行验证：`npm run build` 退出 0；`node --test dist/tests/worker.test.js` 通过，7/7。复用未发生实现/依赖/配置变更后的实现交付结果：`npm test` 55/55；15 个归属文件的 Biome 检查退出 0（`tests/store.test.ts` 有两条既有 `noNonNullAssertion` 警告）；归属文件 `git diff --check` 退出 0。三次基准数据来自该实现交付，不因文档修改重复运行。
- 遗留边界见 [README](../README.md#实现边界)；未测量真实代理任务 token/费用，也不宣称一般定位准确率或单文件更新稳定加速。

### 2026-10-19 — Rust 跨文件关联与交付收尾

- 完成 Rust 跨文件模块/use 解析、显式参数及 `let` 类型注解关联和保守的 inherent impl 调用关系；关系证据维持 `syntax`，不进行编译器类型推断。升级 Rust 解析配置版本，使未变化源码的旧持久化索引也重建；README、当前状态与决策记录已同步实际边界。新增 Rust 关系、遮蔽/歧义、增量更新和旧索引回归；未混入 Vue 交付。
- 验证：`npm test` 通过，35/35；触发 TypeScript build 并执行全量 `dist/tests/*.test.js`。
- 遗留：不支持边界见 [README](../README.md#实现边界)。

### 2026-10-19 — Vue 静态绑定与增量刷新收尾

- 核对并交付 Vue Options API 静态 props/data/setup 成员绑定、`v-for`/`v-slot` 局部作用域及增量刷新回归；README 已包含真实支持边界，本次无需重复修改。Rust 后续模块/use 与显式类型关联的待实现边界另记于 [设计决策](decisions.md)。
- 验证：`npm run build` 通过；`node --test dist/tests/frameworks.test.js dist/tests/vue-incremental.test.js` 通过，11/11；`npx biome check src/core/engine.ts src/languages/typescript.ts src/languages/vue.ts src/languages/vue-template.ts tests/frameworks.test.ts tests/vue-incremental.test.ts` 通过，6 files，无修改。
- 遗留：Rust 跨文件与显式类型关联尚待实现及验证。

### 2026-10-18 — Vue 静态绑定与增量刷新

- 扩展 Vue Options API 静态 props/data/setup 返回成员绑定，并将 `v-for`/`v-slot` 改为局部作用域解析；不支持或有歧义的形式产生 warning 并保守跳过相关子树。框架配置版本提升以重建旧 Vue 解析索引；增量回归覆盖绑定变化、作用域遮蔽、行号偏移、删除及跨文件组件引用。
- 验证：`npm test` 通过，29/29。实际执行的 `npx biome check src/core/engine.ts tests/vue-incremental.test.ts` 未通过：报告增量测试文件 import 排序、`import type` 及格式问题；本次文档收尾未改代码。
- 遗留范围见 [README](../README.md#实现边界)；Vue 不执行宏或动态选项，不完整模拟 Options API 实例类型。

### 2026-10-18 — Vue 与 React 支持

- 新增 Vue SFC 虚拟脚本、组件/模板符号、模板绑定与组件导入关系；保留原始路径、Unicode/CRLF 范围，报告不支持的外置和预处理块。
- React 补足内联 memo/forwardRef、匿名默认导出与 Hook 解构绑定；已有 JSX/TSX 关系继续使用 TypeScript 类型解析。
- 6 项框架回归通过，覆盖源码范围、模板/事件引用、跨文件与路径别名、忽略/修改/删除、Options API、TSX、作用域遮蔽、大小写、解构 props/state 和 worker。原始前 3 项用例实现前均失败。
- 验证：`npm run build && node --test dist/tests/frameworks.test.js`、`project(action: "check")` 的类型检查/lint/全量测试均通过；`npm pack --dry-run --json` 成功且包含 Vue 和 Rust 运行时适配器。
- 遗留范围见 [README](../README.md#实现边界)。

### 2026-10-18 — Rust 语言适配

- 完成 Rust Tree-sitter 适配、独立 symbol kind、扫描分流、局部调用与包含关系、哈希复用、`target/` 忽略、工具描述和边界文档。
- 新增 5 项 Rust 回归：符号和 Unicode 源码范围、混合语言/忽略/修改/重命名/删除、错误恢复、worker、路径与变量遮蔽。实现前前 4 项用例均失败，实现后 5 项通过。
- 验证：`npm run build && node --test dist/tests/rust.test.js`；`project(action: "check")` 的 typecheck、lint、全量测试通过；`npm pack --dry-run --json` 成功，包内包含 `dist/src/languages/rust.js`。
- 遗留范围见 [README](../README.md#实现边界)，不把语法调用宣称为类型解析。
