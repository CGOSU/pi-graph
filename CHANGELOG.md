# Changelog

## Unreleased

- `graph_locate` / `graph_inspect` 新增 Dart、Go、Kotlin 源码符号导航，含保守的同文件语法调用关系；不提供编译器级类型解析或跨文件关系。
- 改进 Android/Termux 安装兼容性：Rust parser 使用随包提供的 WebAssembly grammar，不再依赖原生 Tree-sitter addon；旧 Rust 索引会在刷新时重建。设备与 Pi 宿主兼容性仍需在目标环境核验。
- Align watcher filtering with source scanning and coalesce pending refreshes.
- Reuse healthy watched snapshots after metadata, configuration, Git and revision checks; retain full-hash fallback and bounded retries for concurrent edits.
- Persist coverage warnings with each transactional revision, including warning-only changes and legacy-index recovery.

## 0.1.0

- JS/TS symbol extraction and resolved local relationships.
- SQLite FTS retrieval with bounded graph expansion and Chinese feature aliases.
- Hash reconciliation, reusable ASTs, transactional snapshots and worker execution.
- pi tools, maintenance commands and a single suffix-free root extension.
