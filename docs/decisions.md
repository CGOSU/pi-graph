# 设计决策

本文件按日期倒序记录已经确认且会影响后续实现的决定；新增决策插入对应日期位置，最新条目在前。临时想法和普通操作记录不写入此处。

## 记录格式

每项决策应包含日期、决定、原因和约束。如果后续改变决定，应注明被替代条目，而不是删除历史。

## 已确认决策

### 2026-11-04 — graph操作动态状态展示

- 用户要求将静态`graph: 10 matches`改为动态展示；扩展展示层跟踪locate、inspect、status和rebuild的开始、完成、失败和取消，不修改查询协议、limit或索引逻辑。
- 本session所有graph操作共享从1开始的序号，包含失败和手动命令；等待时以本地单调时钟显示耗时，不伪造扫描阶段或百分比。只在有UI且请求未完成时每秒刷新文字，不轮询worker。各状态含义见[README](../README.md)。
- 并发未收敛时显示pending；收敛后保留最近发起操作的结果。会话边界先失效旧展示回调并解除旧client引用，再等待关闭，防止迟到结果或旧关闭覆盖新session。统计不持久化，原始工具错误继续抛出。

### 2026-11-04 — 独立精确名称匹配与严格 scope

- 精确与完整名称折叠匹配独立进入候选，不受模糊词法的 confidence、minimum 或 diversity 门槛淘汰；模糊词法候选仍使用原置信度筛选。预算保持 FTS 至多 80 项、名称至多 40 项，公共 API 不变。名称等级为 4/3/2/1：原样限定名、原样短名、折叠限定名、折叠短名；仅当限定名与短名不同时建立限定名候选。名称 SQL 候选在同等级内以 callable 优先、稳定 ID 选择；最终检索排序仍结合词法相关性和 diversity，且不跨越名称等级。原始标识符保留 Unicode 组合字符，折叠统一用 JavaScript `toLowerCase()`；查询不因只保留前 32 个标识符而丢失明确的原样标识符，外部查询仍限 2,000 字符。
- 使用独立 `symbol_names` SQLite 表，每个 symbol 至少一条短名行，限定名与短名不同时另加一行；表为 `WITHOUT ROWID`，主键 `(symbol_id, qualified)`，`folded_name,name` 覆盖索引，并明确启用外键。新库和旧库的 DDL、回填及索引在同一个 `BEGIN IMMEDIATE` 事务中完成；事务内二次检查并以表存在作为迁移完成标记，不另设版本键。失败时回滚并关闭连接，以便下次打开重试。名称更新和删除与 symbol 变更处于同一提交事务。不引入网络访问或新依赖。
- scope 使用区分大小写的 BINARY 路径范围，并在候选 limit 前过滤，避免 `src` 命中 `SRC` 或相似前缀。无 scope 的普通 FTS 分支使用 `d.rank` 排序；带 scope 的分支继续使用 `bm25`。合成 GraphStore 测量支持前者的收益及首次写入成本；本轮不新增邻居 top-K 索引。测量与限制见[会话记录](session-log.md)。

### 2026-11-04 — 混合查询的有界名称召回与局部证据归并

- 本条最初记载的 FTS 内名称候选与排序奖励方案已由上方独立名称索引决策取代；候选预算仍为最多 80 个 FTS 和 40 个名称候选。
- 多概念行为查询且未明确查找变量/字段时，依据持久化 `contains` 关系将局部变量的不同文本线索去重归并到所属函数/方法，不把局部变量单独占用返回名额；名称明确匹配的变量、字段及可调用闭包保留独立结果。此关系证据仅为 `syntax` 包含，不宣称类型解析，也不将图邻居当成文本匹配。
- 名称召回已由上方独立名称索引决策取代，局部归并规则仍有效；回归验证见 [会话记录](session-log.md)，相关陷阱见 [踩坑记录](pitfalls.md)。

### 2026-11-04 — 修补 Kotlin `open` 软关键字解析并迁移索引

- Kotlin grammar v1.1.0 原本将 `open` 仅作为继承修饰符，缺少其在标识符上下文的保留标识与歧义冲突处理；合法属性 `var open = true` 会造成 ERROR 节点、解析告警及后续声明丢失。对固定上游源码保留最小 patch：将 `open` 加入 reserved identifier 并与 inheritance modifier 声明冲突处理；修饰符场景仍须正常解析。
- 由固定的 upstream v1.1.0 源码 tar、仓库 patch、Tree-sitter CLI 0.25.10 和 Emscripten 4.0.10 构建 WASM；源档案、patch、构建命令及最终资源 SHA-256 写入 `grammars/sources.json`。原先使用的 Kotlin WASM wrapper 资源已被此固定源码构建取代。
- 图索引配置从 `syntax-v1` 提升为 `syntax-v2`，确保未变化的源码文件也重建符号和告警，修复旧快照中 `Resource` 被错误识别为 enum 的记录。不改变 Kotlin 语法分析的“非编译器语义”边界或公共 API。验证与未部署范围见 [会话记录](session-log.md)。

### 2026-11-04 — 批量更新 SQLite FTS5 文档

- `documents.id` 在 FTS5 中是 `UNINDEXED` 列，按 id 单条删除会反复扫描虚拟表；有大量变更符号时刷新开销随变更数和索引规模相乘增长。
- 收集所有变更/删除文档的 ID 后执行一次 `DELETE ... id IN (SELECT value FROM json_each(?))`，再插入新增/更新文档；不受影响的全文文档保持原样，事务和公开检索语义不变。新增批量检索回归，并以真实语料规模验证更新路径。
- 该优化只覆盖 SQLite 持久化阶段，不代表解析、全项目扫描或关系构建已变为局部增量；真实数据测量和待部署边界见 [会话记录](session-log.md)。

### 2026-11-04 — Dart、Go、Kotlin grammar 与局部关系

- 复用 `@vscode/tree-sitter-wasm` runtime 和其 Go grammar；Dart grammar 固定上游 `UserNobody14/tree-sitter-dart` revision `a9bdfa3db2fbc9b9f12c93450d04a671f33a5102`。Kotlin grammar 最初通过 `@binclusive/tree-sitter-kotlin-wasm` 分发；该 WASM 资源已由 v1.1.0 上游源码及仓库 patch 重建取代，原因与当前固定来源见同日后续的 `open` 软关键字决策。Dart/Kotlin WASM 资产与原始 MIT license 随包发布，SHA-256 在 runtime 加载时核验。避免直接依赖 node engines >=26 的 Dart/Kotlin npm WASM wrapper，保持项目 Node >=22.19 契约。
- 仅以语法树解析声明、UTF-16源码位置、包含和可唯一确认的同文件调用；遮蔽、重载歧义、未知接收者、跨文件/导入和框架运行时语义不猜测。扩展支持的文件后缀同步使旧索引配置失效。
- 实际 grammar hashes 见 `grammars/sources.json` 及可执行完整性检查；README 记录能力与限制，完整验证见 [会话记录](session-log.md)。

### 2026-11-04 — Rust parser 使用随包提供的 WebAssembly runtime

- 以 `@vscode/tree-sitter-wasm` 提供的 runtime 与 Rust grammar 替代 `tree-sitter`/`tree-sitter-rust` 原生 addon，避免在 Android/Termux 上因无 Android 预编译 addon 而进入 node-gyp 本地构建；运行时从安装包加载 WASM，不下载 grammar，不静默跳过 Rust。
- 保留既有 Rust 符号与关系解析契约；异步初始化 parser，缓存解析树并在替换、删除或 engine 关闭时释放。解析配置版本更新，使既有 Rust 图在刷新时重建。
- 验证了 darwin/arm64 Node 上的生产依赖安装模拟（npm 设置 `--os=android --cpu=arm64`）、包内无 `.node` addon、实际 WASM Rust 检索、缺失 grammar 的错误及恢复、worker、完整 67 项回归与 typecheck。该安装模拟没有在 Android 执行 Node，Android/Termux 和 Pi 宿主兼容性仍待真机验证。

### 2026-11-04 — 先验证新鲜度再复用快照

- 复用仅用于递归监听健康的 worker，查询仍执行轻量文件身份核验和配置/Git/revision 核验；监听事件是失效提示，不是唯一的新鲜度证据。保持无监听模式逐次内容扫描及显式 rebuild 的强制语义。具体检查与兜底窗口见 [README](../README.md#实现边界)。
- 扫描前记录身份、编译后再次核验，连续写入时有界重试，避免无限刷新占用队列。保留已有取消标记和事务边界，不合并不同请求的取消权限。
- SQLite metadata 增加同事务写入的 `warnings` 与 `scanWarnings`；后者用于识别被跳过文件的诊断变化，前者保存该 revision 的完整公开诊断。缺失/无效旧诊断触发一次重建，不静默恢复为空。

### 2026-10-26 — worker 协作取消与优化评测边界

- 每个请求使用共享原子取消标记，使主线程能在 worker 被同步编译占用时通知取消；不通过终止共享 worker 或长期维护取消 ID 注册表实现。排队请求跳过执行；活动请求在扫描 I/O、编译阶段之间和 SQLite 提交前检查取消。
- 同步编译不能抢占。SQLite 事务开始后必须完整完成并与对应内存快照一起发布；晚到取消不能中断事务或撤销已提交状态。保留既有公共工具参数与返回语义。
- 性能与检索结论限于固定输入和合成基准：只报告已观察到的热查询改善，不推断一般项目准确率、稳定的冷索引/单文件更新或提交加速，也不把字符/字节数当作计费 token。具体测量与验证见 [会话记录](session-log.md)，公开支持边界见 [README](../README.md#验证与打包)。

### 2026-10-19 — Rust 跨文件模块/use 与显式类型关联

- 后续 Rust 改动沿用 Tree-sitter 与共享图契约；跨文件解析仅基于扫描到的 Rust 文件和唯一模块/符号映射，覆盖 inline/常规模块、`crate`/`self`/`super` 路径及明确限定路径、简单/别名/分组 `use` 导入。歧义或缺少模块上下文时不连目标边。
- 在已建立的模块/use 上下文中，仅由显式参数或 `let` 类型注解（含已支持导入别名及普通引用）关联唯一本地 struct/enum 的 inherent impl 方法与明确类型路径调用；关系证据一律为 `syntax`，不代表编译器解析或类型推断。缓存解析事实时，目标上下文须随当前文件集重建/失效，避免增量旧边。
- 本轮明确不支持 glob/re-export 链、`extern crate`、`#[path]`、`cfg` 选择、宏生成、跨 crate/workspace、trait/泛型分派、类型别名展开、智能指针/Deref/强制转换或基于构造/返回/任意表达式的类型推断；未知或不唯一时不猜测。保持单文件解析、共享 symbol/edge、持久化及 TS/Vue 管线兼容，不新增依赖或调用 Cargo/rust-analyzer。
- 实现与回归已完成并经交付验证；实际公开支持边界以 [README](../README.md#实现边界) 为准。旧 `frameworks-v2:rust-v1` 索引使用新的 Rust 配置版本，在源文件未变时也会重建 Rust 图；持久化格式及其他语言配置版本保持不变。

### 2026-10-18 — Vue 静态选项绑定与模板局部作用域

- 在不执行用户代码或宏的前提下，解析静态可确认的 Options API props、data/setup 直接返回对象成员，并在模板静态绑定模式下建立 `syntax` 引用。
- 对 `v-for`/`v-slot` 使用显式局部作用域；无法唯一解析的选项或作用域以 warning 表示，只跳过受影响绑定/子树，不推断动态键、展开或不支持的模式。
- 该能力不模拟完整 Vue 实例类型；现有 `.vue` 源码范围与图谱公共类型保持不变。详见 [README 支持边界](../README.md#实现边界)。

### 2026-10-18 — Vue 与 React 复用 TypeScript 图谱

- Vue 使用官方 `@vue/compiler-sfc` 与 `@vue/compiler-dom` 解析，不引入运行时 Vue/React，也不执行目标项目代码。
- 脚本外内容按 UTF-16 长度替换为空白，虚拟 JS/TS 文件只存在于内存；所有公开符号和诊断保留 `.vue` 路径与原始范围，组件默认导出映射到原文件 symbol。
- 模板绑定证据为 `syntax`；带局部作用域的 `v-for`/`v-slot` 子树暂不猜测关系，避免把局部变量连到脚本同名变量。
- React 复用 JSX/TSX 的类型解析关系，补足匿名默认导出、内联 `memo`/`forwardRef` 和解构绑定。

### 2026-10-18 — Rust 语法层索引

- 扩展现有扫描、存储和检索链路，使用 `tree-sitter` + `tree-sitter-rust`，无需调用 Cargo 或执行目标项目代码。
- Rust 保留独立 symbol kind；同文件调用只在语法可辨识且目标唯一时连边，证据标注 `syntax`。不猜测跨文件导入、任意接收者类型或宏展开。
- 同文件图按内容哈希复用；版本化解析配置触发旧索引刷新。原生依赖采用包自带预编译二进制，缺失时需要 node-gyp 环境。此安装策略已被 2026-11-04 的 WASM 决策替代。
