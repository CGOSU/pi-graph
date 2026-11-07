# pi-graph

为 pi Agent 定位小功能的增量代码图。目标是一次查询返回少量可信 symbol，而不是展示整仓代码。

## 安装

需要 Node.js >= 22.19，以及支持扩展的 pi。当前已在 pi 1.2.0 上验证。

本地开发安装：

```sh
pnpm install --frozen-lockfile
pnpm check
pi install D:/Code/Javascript/pi-graph
```

不写入 pi 配置、仅临时加载：

```sh
pi -e D:/Code/Javascript/pi-graph
```

### Android / Termux

Rust 解析使用随包提供的 WebAssembly Tree-sitter runtime 和 Rust grammar，不需要 Android 原生 addon、node-gyp、Python/C++ 工具链或联网编译。Termux 环境仍须提供 Node.js >= 22.19、`node:sqlite`，并能运行 pi；确认 Node 版本后按通常方式安装/更新扩展，再重启 pi：

```sh
node --version
```

Android 真机与不同 Termux/Node 发行版尚未验证；如果 pi 宿主本身无法在该设备运行，仅替换解析器不能解决宿主兼容问题。符合要求且可运行 pi 的 Termux 环境可按 pi 当前 package source 格式安装或更新 Git 扩展，并重启 pi。

本地源码变更后执行 `pnpm build`，然后重新加载 pi。Git 安装会通过 `prepare` 构建；若以 production-only 模式安装源码，pnpm 会跳过 `prepare`，需另行执行 `pnpm run prepare`。npm 发布包包含已构建文件，不要求用户构建。

包只声明根目录 `index.ts` 为扩展入口。内部模块不会独立加载，扩展列表显示 `pi-graph`；从 Git 安装时显示来源仓库名，不附加 `:src`。测试直接调用 pi 的资源加载器和展示逻辑，并在隔离配置目录执行实际 `pi install`，不会修改用户已有安装。

## 使用

Agent 工具：

- `graph_locate({ query, scope?, limit? })`：自然语言或标识符定位，默认最多 6 个结果；`limit` 为 3～10。证据不足时不凑数。
- `graph_inspect({ id, neighbors?, maxCharacters? })`：读取定位结果的当前源码和有限邻居。默认最多 6 个邻居、8,000 个源码字符。

示例：

```json
{ "query": "取消生成后按钮一直转圈", "scope": "src", "limit": 6 }
```

每个定位结果包含 symbol ID、路径、当前行号、签名、职责角色、命中原因和代码证据。关系区分 JS/TS 类型解析确认的调用/引用，以及 Vue 模板、Rust、Dart、Go、Kotlin 的语法证据。重命名或删除后旧 ID 可能失效，应重新定位。

维护命令：

- `/graph status`：索引状态、文件和 symbol 数量、版本、诊断。
- `/graph rebuild`：强制重新解析并提交新的索引快照。

状态栏随 `graph_locate`、`graph_inspect` 和上述 graph 命令更新。例如等待时显示
`graph: locate #8 · pending 3.0s`，完成后显示
`graph: last locate #8 · 10 results · 3.4s`；失败和取消分别显示 `failed`、`cancelled`。
inspect 显示邻居数量，status/rebuild 显示索引 symbol 数量。`#8` 是本次 session 的 graph
操作序号，包含失败、取消和手动命令；`10 results` 只是该次查询返回的候选数量。

等待时间包含排队、刷新和查询，不代表已进入某个索引阶段或可计算的完成百分比。
仅在有 UI 且存在未完成请求时每秒刷新文字，不额外查询索引。并发时显示尚未完成的操作及数量，
全部结束后保留最近发起操作的结果，较早操作迟到不会覆盖它。切换/关闭 session 清除状态与计时器，
序号重新开始；reload 后也从新序号开始，不持久化调用统计。

`scope` 是 pi 当前工作目录内的相对目录或文件路径，不接受越界路径；匹配大小写敏感，并要求完整路径段边界。索引根目录为当前会话的工作目录。

## 实现边界

- JS、TS、JSX、TSX、MJS、CJS、MTS、CTS，Rust（`.rs`）、Dart（`.dart`）、Go（`.go`）、Kotlin（`.kt`/`.kts`）和 Vue SFC（`.vue`）；不索引 `.d.ts`。
- TypeScript Compiler API 提取函数、方法、类、类型、顶层变量、属性及可解析调用/引用；支持导入别名、重导出和根配置的路径别名。
- React：支持 JSX/TSX 函数/类组件、匿名默认导出、内联 `memo`/`forwardRef` 包装、Hook 解构状态；复用 TypeScript 的 JSX 组件引用、Hook/函数调用解析。不执行组件，也不推断自定义 HOC 的运行时语义。
- Vue：通过官方 SFC 解析器提取普通 `<script>` 和 `<script setup>`（JS/TS/JSX/TSX），保留原 `.vue` 文件的行号和 UTF-16 源码范围；跨 JS/TS/Vue 的 `.vue` 导入和根配置路径别名可解析。组件和模板分别建 symbol，模板中的可辨识绑定、事件和组件标签引用标注为 `syntax`。支持 setup 绑定、Options API 的 methods/computed/components，以及静态 props（字符串数组或对象）、`data`/`setup` 直接返回的唯一静态对象成员。
- Vue 模板支持静态可解析的 `v-for`/`v-slot` 绑定模式，包括解构与默认值；局部别名只在对应子树遮蔽同名外部绑定，循环源、默认值表达式及无关兄弟节点仍可解析。无法静态解析或有歧义的作用域会产生 warning，并跳过受影响的局部子树；不猜测动态键、展开或非静态返回中的绑定。模板表达式区分大小写；仅组件标签支持唯一匹配的 kebab-case 名称映射。
- Vue 不编译样式、不执行宏，也不完整模拟 Options API 实例类型。外置 `src`、预处理模板和非 JS/TS 脚本会报告 warning；无法解析的模板表达式及不支持的局部作用域/选项形态也会报告 warning，不会将其伪装为已解析。
- Rust 使用 Tree-sitter 提取函数、方法、struct、enum/variant、trait、模块、类型别名、字段、常量、静态变量和宏定义。包含关系及可辨识调用统一标注为 `syntax`，显式类型注解关联仅表示语法层关联，不是编译器类型解析或推断。基于已扫描文件支持 inline module、常规模块声明到唯一 `foo.rs`/`foo/mod.rs` 的映射、`lib.rs`/`main.rs` 等 crate root、嵌套模块，以及 `crate`/`self`/`super` 路径；支持模块作用域内简单、别名、分组/嵌套 use 和明确限定路径。函数/方法参数或 `let` 显式标注为唯一本地 struct/enum 类型时，可关联 inherent impl 方法及明确类型路径调用；普通引用、已支持 use 别名和 `self`/`Self` 也受限支持。歧义、缺失模块上下文或多个 crate root 共用模块文件时不猜测目标；不推断构造/返回/任意表达式类型，不支持 glob、pub use 重导出链、`extern crate`、`#[path]`、`cfg` 选择、宏生成、跨 crate/workspace、trait/泛型分派、类型别名展开、智能指针/Deref 或强制转换。无需安装 Rust 工具链。旧 Rust 解析配置版本的持久化索引会在刷新时重建，即使 Rust 源文件未变化。
- Rust parser runtime 与 grammar 以 WebAssembly 资源随 `@vscode/tree-sitter-wasm` 包提供；不需要 Rust 工具链、平台原生 `.node` addon 或 node-gyp。默认忽略 Rust 的 `target/` 构建目录。旧原生 Rust 索引配置会在刷新时重建。
- Dart（`.dart`）、Go（`.go`）、Kotlin（`.kt`/`.kts`）共用 `web-tree-sitter` WASM runtime：Go grammar 随 runtime 包提供，Dart/Kotlin grammar 以固定版本、校验和及许可证随项目发布。索引常见 class/struct/interface/enum、函数/方法、字段/属性、局部声明、源码范围及包含关系；同文件调用仅在目标唯一且未被参数或局部绑定遮蔽时连边，证据标记 `syntax`。Go receiver 方法按显式 receiver 类型关联；Dart/Kotlin 仅关联类内同名方法和 `this` 调用。歧义、重载、未知接收者或不可确定的作用域不猜边。Dart/Go/Kotlin 不做编译器类型解析、包/import/模块跨文件关联、跨语言调用，也不模拟 Flutter、Go 服务框架或 Android API 运行时语义。语法错误保留可解析 symbol 并附 warning。添加语法支持会使旧图配置索引在刷新时重建。
- SQLite + FTS5 持久化；默认缓存目录为项目下 `.pi-graph/`，建议加入目标项目的 `.gitignore`。
- 词法召回使用 camelCase 切分、中文双字切分及少量中英功能词映射。另有独立名称索引召回最多 40 个名称候选，不依赖 FTS 命中；原样限定名、原样短名、大小写折叠限定名、折叠短名依次优先。名称命中不受模糊词法候选的置信度门槛影响，最终仍在同等级内结合词法相关性和多样性排序；FTS 词法候选最多 80 个。
- 名称索引保留标识符原样大小写与 Unicode 组合字符，并以 JavaScript `toLowerCase()` 计算折叠名称；查询不因只保留前 32 个标识符而丢失明确的原样标识符，外部查询仍限制为 2,000 字符。检索结果再做一跳局部图扩展、去重和预算裁剪。
- 查询前校验快照。递归监听健康时，核对已访问目录、源文件及存在/缺失的 ignore 文件的 inode、大小、mtime/ctime 和权限，并检查 Git HEAD/ref、继承配置内容及数据库 revision；全部未变才复用内存源码，避免每次定位/检查都重读全仓内容。删除、重命名、新增目录、忽略规则或配置变化即使监听事件尚未送达，也会触发重新扫描。扫描及编译后再次核验；连续变化最多尝试三次，失败时保留上个快照并要求重试。
- 监听不可用或失效时，每次查询重新扫描内容哈希；健康监听下仍在距上次扫描满 30 秒后的下一次查询重新核对哈希，显式 `/graph rebuild` 始终强制重建。极端情况下若文件系统丢失事件且所有检查到的元数据均未变化，可能在此窗口内复用旧快照；不保证对外部持续写入提供文件系统原子快照。配置核验不重复枚举 TypeScript 项目源文件，源文件范围由图扫描器决定。
- worker 内串行执行索引操作，避免阻塞 pi 主线程。监听与扫描共享目录排除、源码类型和嵌套 ignore 规则；忽略 `.pi`、`.git`、构建/缓存等噪声，后台刷新队列合并为至多一个待执行刷新。请求取消会让排队任务跳过执行，并在扫描 I/O、同步编译阶段之间及 SQLite 提交前检查；同步编译本身不能抢占。事务一旦开始会完整提交并发布对应内存快照；取消不会强制终止共享 worker，也不能撤销已提交事务。
- 覆盖范围和解析 warnings 随 revision 同事务持久化，重开未变化的索引仍返回原诊断；旧索引缺失诊断元数据时重建一次。仅超大文件的跳过警告发生增减也会发布新 revision，不以空警告冒充已完全解析。
- SQLite 事务保证查询读到完整快照。未变化的 AST 和检索文档复用；发生变化时目前会重新提取全项目 symbol 并重建关系，以优先保证正确性，尚未实现严格的受影响子图更新。

**当前不是向量语义搜索。**不调用远端模型，不生成整仓 LLM 摘要；中文功能词映射不等同于通用跨语言理解。Embedding provider、功能级评测集、更多语言适配及依赖传播优化属于后续工作。

也不承诺动态调用、运行时注册或反射关系完整；无命中不表示代码不存在。大型 monorepo 的独立配置和 project references 尚未完整支持。超出 2 MB 的单文件会跳过并报告。

## 忽略与安全

默认遵守各目录的 `.gitignore` 和 `.graphignore`，排除依赖、构建产物、缓存、pi/empryo 运行数据；不跟随符号链接，不执行被索引的项目代码。

索引文件包含源码片段和检索文本，请按源码同等级保护。仓库注释和字符串只作为检索数据，不作为 Agent 指令。工具不修改项目源码，但会写入可重建的索引缓存。

## 项目结构

```text
index.ts                 # 唯一 pi 入口
src/core/                # 文件扫描、SQLite、检索、引擎、worker 与客户端
src/languages/           # 语言解析适配器
src/pi/                  # pi 工具、命令和生命周期接入
tests/                   # 定位、增量、配置、worker、安装与展示回归
```

`core` 和语言适配器不依赖 pi。宿主提供的 pi API 与 TypeBox 声明为 peerDependencies，不打入运行时依赖。

## 验证与打包

```sh
pnpm check
pnpm benchmark
pnpm pack --dry-run
```

回归覆盖中文功能定位、当前行号、修改/删除/重命名、忽略与 scope、SQL 特殊字符、别名/方法关系、配置继承变更、worker 并发与取消，以及 pi 安装后的单入口展示。

合成性能测量（2026-10-26，Apple M6、darwin/arm64、Node v26.11.1；每次 50,103 行、170 个文件、5,015 个 symbol，连续 3 次）：冷索引中位数 1,246 ms，热查询中位数 2 ms、P95 中位数 4 ms，单文件更新中位数 244 ms。与同机同口径的优化前对照相比，冷索引中位数为 1,252→1,246 ms，热查询中位数为 4→2 ms、P95 为 8→4 ms，单文件更新中位数为 231→244 ms。只观察到该合成场景的热查询改善；冷索引差异不足以证明稳定加速，单文件更新未变快，且变化时仍会重新提取全项目 symbol 并重建关系。独立 SQLite 提交样本也未证明稳定显著加速。

冻结同一输入图的 7 个定位场景中，首位目标命中由 3/7 提至 7/7；模型可见正文从 11,904 降至 10,979 字符（12,036→11,101 UTF-8 字节），结构化结果从 20,122 降至 17,440 字符。3 个有匹配项的展示对照样例正文长度下降 4%–20.3%。这些是固定样例的排序和序列化长度，不代表一般项目定位准确率；字符数与 UTF-8 字节数不是计费 token，也未测量真实代理任务的 token 或费用。可通过 `pnpm run benchmark -- 50000` 调整基准规模，结果会随运行环境变化。

Node 的 `node:sqlite` 在部分支持版本上会输出实验性 API 警告，不影响功能。
