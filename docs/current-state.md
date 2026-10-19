# 当前状态

“最近一次更新”列表按日期倒序排列，当前状态正文只描述现状，不按时间排列。

## 项目

- 名称：`pi-graph`
- 定位：Incremental symbol graph for focused agent code navigation

## 当前目标

- 提供 JS/TS、React、Vue SFC 与 Rust 的增量符号定位和源码检查。

## 已知状态

- Vue SFC 支持静态 Options API props/data/setup 返回成员绑定及 `v-for`/`v-slot` 局部作用域解析；不支持形态以 warning 标示并保守跳过，完整边界见 [README](../README.md#实现边界)。React 增补包装组件、匿名默认导出与 Hook 解构状态。
- Rust `.rs` 已接入扫描、检索、inspect、worker 和内容哈希刷新；解析边界见 [README](../README.md#实现边界)，适配策略见 [设计决策](decisions.md)。

## 待处理

- Rust 跨文件导入与类型级调用解析尚未实现。

## 最近一次更新

- 2026-10-19：Vue 静态 Options API 绑定、模板局部作用域和增量刷新改动已核验并独立交付；当前支持边界见 [README](../README.md#实现边界)，本轮验证见 [会话记录](session-log.md)。
- 2026-10-18：补齐 Vue 静态 Options API 绑定、模板局部作用域和增量刷新回归；边界及验证见 [README](../README.md#实现边界) 与 [会话记录](session-log.md)。
- 2026-10-18：新增 Vue SFC 与 React 框架回归支持。
- 2026-10-18：新增 Rust 语法层索引，保留 JS/TS 类型解析链路。
