# 当前状态

“最近一次更新”列表按日期倒序排列，当前状态正文只描述现状，不按时间排列。

## 项目

- 名称：`pi-graph`
- 定位：Incremental symbol graph for focused agent code navigation

## 当前目标

- 提供 JS/TS、React、Vue SFC、Rust、Dart、Go 与 Kotlin 的增量符号定位和源码检查。

## 已知状态

- Dart `.dart`、Go `.go`、Kotlin `.kt`/`.kts` 现由 Tree-sitter WASM parser 索引；支持常见声明、源码范围、包含关系与有歧义保护的同文件语法调用，不提供编译器级类型、跨文件包关系或 Flutter/Android 框架语义分析。Dart/Kotlin grammar 随包发布，来源、许可和升级校验见 [决策](decisions.md)；旧图配置会在刷新时重建。
- 监听过滤、刷新合并、带新鲜度核验的快照复用与 revision 诊断恢复已完成；公开行为和 30 秒哈希兜底边界见 [README](../README.md#实现边界)。
- Vue SFC 支持静态 Options API props/data/setup 返回成员绑定及 `v-for`/`v-slot` 局部作用域解析；不支持形态以 warning 标示并保守跳过，完整边界见 [README](../README.md#实现边界)。React 增补包装组件、匿名默认导出与 Hook 解构状态。
- Rust `.rs` 支持保守的跨文件模块/use 关系和显式参数/let 类型注解关联；关系证据为 `syntax`，不代表类型推断。解析器使用 `@vscode/tree-sitter-wasm` 提供的 WASM runtime 与 grammar，安装不再依赖原生 Tree-sitter addon；旧 Rust 解析配置版本的持久化索引会刷新重建。Android/Termux 未经真机验证。完整边界见 [README](../README.md#实现边界)，适配策略见 [设计决策](decisions.md)。

## 待处理


## 最近一次更新

- 2026-11-04：修复 Kotlin grammar 将合法的 `open` 属性名误判为修饰符的问题，并将图索引配置升至 `syntax-v2` 以重建旧解析结果；FlClash 目标测试提取 84 个符号、79 条关系且无 warning。修复尚未部署到 Pi 安装副本；见 [设计决策](decisions.md) 与 [会话记录](session-log.md)。
- 2026-11-04：优化 SQLite FTS5 文档批量更新，避免每个变更符号各自扫描全文索引；FlClash 93,619 符号快照在临时库通过数据一致性与检索验证。实现细节和边界见 [设计决策](decisions.md) 与 [会话记录](session-log.md)。
- 2026-11-04：新增 Dart、Go、Kotlin 符号导航与保守的同文件调用关系；grammar 资产随包发布并固定校验和。全量测试通过，见 [设计决策](decisions.md) 和 [会话记录](session-log.md)。
- 2026-11-04：Rust parser 改用 WASM，去除原生 addon 安装要求；生产安装与全量回归通过，Android 真机尚未验证。见 [设计决策](decisions.md) 和 [会话记录](session-log.md)。
- 2026-11-04：完成监听/刷新与持久化诊断修复，隔离安装及全量回归通过；验证见 [会话记录](session-log.md)。
- 2026-10-26：完成增量检索与 worker 取消优化的统一文档收尾；公开边界见 [README](../README.md#实现边界)，固定样例测量与验证见 [会话记录](session-log.md)。
- 2026-10-19：完成 Rust 跨文件模块/use、显式类型注解关联及旧持久化索引迁移；支持边界见 [README](../README.md#实现边界)，验证见 [会话记录](session-log.md)。
- 2026-10-19：Vue 静态 Options API 绑定、模板局部作用域和增量刷新改动已核验并独立交付；当前支持边界见 [README](../README.md#实现边界)，本轮验证见 [会话记录](session-log.md)。
- 2026-10-18：补齐 Vue 静态 Options API 绑定、模板局部作用域和增量刷新回归；边界及验证见 [README](../README.md#实现边界) 与 [会话记录](session-log.md)。
- 2026-10-18：新增 Vue SFC 与 React 框架回归支持。
- 2026-10-18：新增 Rust 语法层索引，保留 JS/TS 类型解析链路。
