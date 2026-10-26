# 当前状态

“最近一次更新”列表按日期倒序排列，当前状态正文只描述现状，不按时间排列。

## 项目

- 名称：`pi-graph`
- 定位：Incremental symbol graph for focused agent code navigation

## 当前目标

- 提供 JS/TS、React、Vue SFC 与 Rust 的增量符号定位和源码检查。

## 已知状态

- Vue SFC 支持静态 Options API props/data/setup 返回成员绑定及 `v-for`/`v-slot` 局部作用域解析；不支持形态以 warning 标示并保守跳过，完整边界见 [README](../README.md#实现边界)。React 增补包装组件、匿名默认导出与 Hook 解构状态。
- Rust `.rs` 支持保守的跨文件模块/use 关系和显式参数/let 类型注解关联；关系证据为 `syntax`，不代表类型推断。旧 Rust 解析配置版本的持久化索引会刷新重建。完整边界见 [README](../README.md#实现边界)，适配策略见 [设计决策](decisions.md)。

## 待处理


## 最近一次更新

- 2026-10-26：完成增量检索与 worker 取消优化的统一文档收尾；公开边界见 [README](../README.md#实现边界)，固定样例测量与验证见 [会话记录](session-log.md)。
- 2026-10-19：完成 Rust 跨文件模块/use、显式类型注解关联及旧持久化索引迁移；支持边界见 [README](../README.md#实现边界)，验证见 [会话记录](session-log.md)。
- 2026-10-19：Vue 静态 Options API 绑定、模板局部作用域和增量刷新改动已核验并独立交付；当前支持边界见 [README](../README.md#实现边界)，本轮验证见 [会话记录](session-log.md)。
- 2026-10-18：补齐 Vue 静态 Options API 绑定、模板局部作用域和增量刷新回归；边界及验证见 [README](../README.md#实现边界) 与 [会话记录](session-log.md)。
- 2026-10-18：新增 Vue SFC 与 React 框架回归支持。
- 2026-10-18：新增 Rust 语法层索引，保留 JS/TS 类型解析链路。
