# 当前状态

“最近一次更新”列表按日期倒序排列，当前状态正文只描述现状，不按时间排列。

## 项目

- 名称：`pi-graph`
- 定位：Incremental symbol graph for focused agent code navigation

## 当前目标

- 提供 JS/TS、React、Vue SFC 与 Rust 的增量符号定位和源码检查。

## 已知状态

- Vue SFC、模板引用和跨文件组件导入已接入；React 增补包装组件、匿名默认导出与 Hook 解构状态，边界见 [README](../README.md#实现边界)。
- Rust `.rs` 已接入扫描、检索、inspect、worker 和内容哈希刷新；解析边界见 [README](../README.md#实现边界)，适配策略见 [设计决策](decisions.md)。

## 待处理

- Rust 跨文件导入与类型级调用解析尚未实现。

## 最近一次更新

- 2026-10-18：新增 Vue SFC 与 React 框架回归支持。
- 2026-10-18：新增 Rust 语法层索引，保留 JS/TS 类型解析链路。
