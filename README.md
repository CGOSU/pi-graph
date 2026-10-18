# pi-graph

为 pi Agent 定位小功能的增量代码图。目标是一次查询返回少量可信 symbol，而不是展示整仓代码。

## 安装

需要 Node.js >= 22.19，以及支持扩展的 pi。当前已在 pi 1.2.0 上验证。

本地开发安装：

```sh
npm install --legacy-peer-deps
npm run check
pi install D:/Code/Javascript/pi-graph
```

不写入 pi 配置、仅临时加载：

```sh
pi -e D:/Code/Javascript/pi-graph
```

本地源码变更后执行 `npm run build`，然后重新加载 pi。Git 安装会通过 `prepare` 构建；npm 发布包包含已构建文件，不要求用户构建。

包只声明根目录 `index.ts` 为扩展入口。内部模块不会独立加载，扩展列表显示 `pi-graph`；从 Git 安装时显示来源仓库名，不附加 `:src`。测试直接调用 pi 的资源加载器和展示逻辑，并在隔离配置目录执行实际 `pi install`，不会修改用户已有安装。

## 使用

Agent 工具：

- `graph_locate({ query, scope?, limit? })`：自然语言或标识符定位，默认最多 6 个结果；`limit` 为 3～10。证据不足时不凑数。
- `graph_inspect({ id, neighbors?, maxCharacters? })`：读取定位结果的当前源码和有限邻居。默认最多 6 个邻居、8,000 个源码字符。

示例：

```json
{ "query": "取消生成后按钮一直转圈", "scope": "src", "limit": 6 }
```

每个定位结果包含 symbol ID、路径、当前行号、签名、职责角色、命中原因和代码证据。关系区分 JS/TS 类型解析确认的调用/引用，以及 Vue 模板引用、Rust 调用和包含关系等语法证据。重命名或删除后旧 ID 可能失效，应重新定位。

维护命令：

- `/graph status`：索引状态、文件和 symbol 数量、版本、诊断。
- `/graph rebuild`：强制重新解析并提交新的索引快照。

`scope` 是 pi 当前工作目录内的相对目录或文件路径，不接受越界路径。索引根目录为当前会话的工作目录。

## 实现边界

- JS、TS、JSX、TSX、MJS、CJS、MTS、CTS，以及 Rust（`.rs`）、Vue SFC（`.vue`）；不索引 `.d.ts`。
- TypeScript Compiler API 提取函数、方法、类、类型、顶层变量、属性及可解析调用/引用；支持导入别名、重导出和根配置的路径别名。
- React：支持 JSX/TSX 函数/类组件、匿名默认导出、内联 `memo`/`forwardRef` 包装、Hook 解构状态；复用 TypeScript 的 JSX 组件引用、Hook/函数调用解析。不执行组件，也不推断自定义 HOC 的运行时语义。
- Vue：通过官方 SFC 解析器提取普通 `<script>` 和 `<script setup>`（JS/TS/JSX/TSX），保留原 `.vue` 文件的行号和 UTF-16 源码范围；跨 JS/TS/Vue 的 `.vue` 导入和根配置路径别名可解析。组件和模板分别建 symbol，模板中的可辨识绑定、事件和组件标签引用标注为 `syntax`；支持 setup 绑定及 Options API 的 methods/computed/components。
- Vue 不编译样式、不执行宏，不完整模拟 Options API 实例类型；外置 `src`、预处理模板、非 JS/TS 脚本报告诊断，`v-for`/`v-slot` 子树暂不推断绑定关系。模板表达式区分大小写；仅组件标签支持 kebab-case 名称映射。
- Rust 使用 Tree-sitter 提取函数、方法、struct、enum/variant、trait、模块、类型别名、字段、常量、静态变量和宏定义；包含关系与同文件可辨识调用标注为 `syntax`，不冒充类型解析结果。支持局部模块路径、`self`/`super`/`crate`、`Self` 和当前 impl 的 `self.method()`；不解析跨文件导入、任意接收者类型、宏展开或 Cargo/`cfg` 条件，不需要安装 Rust 工具链。
- Tree-sitter 为原生依赖，支持的平台优先使用预编译包；无预编译包时安装需要 node-gyp 对应的 Python/C++ 构建环境。默认忽略 Rust 的 `target/` 构建目录。
- SQLite + FTS5 持久化；默认缓存目录为项目下 `.pi-graph/`，建议加入目标项目的 `.gitignore`。
- 词法召回、camelCase 切分、中文双字切分及少量中英功能词映射；一跳局部图扩展、去重、预算裁剪。
- 查询前校验文件哈希；删除、重命名、切分支和忽略规则变化会反映到下一次查询。配置变化，包括 `tsconfig` 的继承配置变化，会使解析关系失效并重建。
- worker 内串行执行索引操作，避免阻塞 pi 主线程。支持递归监听的平台会后台合并文件变化；不支持监听时，查询仍会校验文件。
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
npm run check
npm run benchmark
npm pack --dry-run
```

回归覆盖中文功能定位、当前行号、修改/删除/重命名、忽略与 scope、SQL 特殊字符、别名/方法关系、配置继承变更、worker 并发与取消，以及 pi 安装后的单入口展示。

合成基准：约 50,000 行、5,015 个 symbol，单次中文功能查询返回 5 个相关 symbol；本机热查询 P95 约 30 ms，首次索引约 2.3 秒，单文件变化约 0.53 秒。该基准只验证规模、延迟和固定功能链，不代表真实项目的定位准确率。可通过 `npm run benchmark -- 100000` 调整规模。

Node 的 `node:sqlite` 在部分支持版本上会输出实验性 API 警告，不影响功能。
