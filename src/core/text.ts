const aliases: Record<string, string[]> = {
  取消: ["cancel", "cancelled", "cancellation", "abort", "aborted"],
  生成: ["generate", "generation", "generated"],
  流式: ["stream", "streaming"],
  按钮: ["button", "click"],
  转圈: ["loading", "busy", "spinner"],
  加载: ["loading", "load"],
  状态: ["state", "status"],
  复位: ["reset", "clear"],
  登录: ["login", "signin", "auth"],
  认证: ["auth", "authenticate"],
  权限: ["permission", "auth", "role"],
  配置: ["config", "configuration", "settings", "options"],
  保存: ["save", "persist", "write"],
  写入: ["write", "save", "persist", "commit"],
  读取: ["read", "load", "fetch"],
  删除: ["delete", "remove"],
  缓存: ["cache", "cached"],
  过期: ["expire", "expiry", "ttl"],
  重试: ["retry", "attempt"],
  超时: ["timeout"],
  停止: ["stop", "abort", "cancel"],
  刷新: ["refresh", "reload"],
  更新: ["update", "refresh", "patch"],
  文件: ["file", "files"],
  哈希: ["hash", "digest"],
  索引: ["index", "indexed", "indexing"],
  定位: ["locate", "find", "resolve", "lookup"],
  查找: ["search", "find", "lookup", "query"],
  搜索: ["search", "find", "query"],
  查询: ["query", "search"],
  启动: ["start", "startup", "boot", "init", "launch"],
  初始化: ["init", "initialize", "setup"],
  监听: ["watch", "watcher", "listen", "listener", "observe"],
  去抖: ["debounce", "timer"],
  防抖: ["debounce", "timer"],
  节流: ["throttle"],
  精确: ["exact", "strict"],
  名称: ["name", "names", "identifier"],
  匹配: ["match", "matched", "matching"],
  解析: ["parse", "parser", "resolve"],
  编译: ["compile", "compiler", "build"],
  构建: ["build", "rebuild", "compile"],
  增量: ["incremental", "delta", "diff"],
  迁移: ["migrate", "migration", "legacy"],
  并发: ["concurrent", "parallel", "queue"],
  队列: ["queue", "queued", "enqueue"],
  错误: ["error", "fail", "failed", "exception"],
  异常: ["error", "exception", "throw"],
  警告: ["warning", "warn", "diagnostic"],
  会话: ["session"],
  消息: ["message"],
  事件: ["event", "emit", "handler"],
  路由: ["route", "router"],
  弹窗: ["dialog", "modal", "popup"],
  分页: ["page", "paginate", "pagination", "cursor"],
  请求: ["request", "fetch", "http"],
  响应: ["response", "reply"],
  连接: ["connect", "connection", "socket"],
  断开: ["disconnect", "close", "closed"],
  关闭: ["close", "closed", "shutdown"],
  打开: ["open", "opened"],
  符号: ["symbol", "symbols"],
  调用: ["call", "calls", "caller", "invoke"],
  引用: ["reference", "references", "import"],
  作用域: ["scope", "scoped"],
  忽略: ["ignore", "ignored", "exclude"],
  测试: ["test", "spec"],
};
const fillerChinese = [
  "为什么",
  "怎么会",
  "怎么样",
  "如何",
  "怎么",
  "怎样",
  "是否",
  "可以",
  "能否",
  "需要",
  "应该",
  "或者",
  "以及",
  "进行",
  "时候",
  "一直",
  "导致",
  "无法",
  "没有",
  "已经",
  "首次",
  "重新",
  "所有",
  "如果",
  "里面",
  "其中",
  "通过",
  "使用",
  "一个",
  "不够",
  "感觉",
  "看看",
  "哪些",
  "哪里",
  "什么",
];
const stopWords = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "of",
  "to",
  "and",
  "or",
  "for",
  "why",
  "how",
  "what",
  "where",
  "when",
  "which",
  "does",
  "do",
  "did",
  "in",
  "on",
  "at",
  "by",
  "from",
  "with",
  "function",
  "const",
  "let",
  "var",
  "return",
  "export",
  "default",
  "string",
  "number",
  "boolean",
  "void",
  "async",
  "await",
]);
export function unicodeTokens(text: string): string[] {
  return (
    text
      .normalize("NFD")
      .replace(/\p{Mn}/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}
export function tokens(text: string): string[] {
  const split = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  const result: string[] = [];
  for (const word of split.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars = Array.from(word);
      if (chars.length === 1) result.push(word);
      for (let i = 0; i < chars.length - 1; i++) result.push(chars.slice(i, i + 2).join(""));
    } else if (!stopWords.has(word) && word.length > 1) result.push(word);
  }
  return [...new Set(result)];
}
export function queryTokenGroups(query: string): string[][] {
  const groups: string[][] = [];
  let remainder = query;
  for (const [phrase, words] of Object.entries(aliases)) {
    if (!query.includes(phrase)) continue;
    const group = groups.find((candidate) => words.some((word) => candidate.includes(word)));
    if (group) group.push(...[phrase, ...words].filter((word) => !group.includes(word)));
    else groups.push([phrase, ...words]);
    remainder = remainder.replaceAll(phrase, " ");
  }
  for (const filler of fillerChinese) remainder = remainder.replaceAll(filler, " ");
  const literals = tokens(remainder).filter(
    (term) => !groups.some((group) => group.includes(term)),
  );
  return [...groups, ...literals.map((term) => [term])].slice(0, 32);
}
export function queryTokens(query: string): string[] {
  return [...new Set(queryTokenGroups(query).flat())].slice(0, 32);
}
export function searchDocument(text: string): string {
  return tokens(text).join(" ");
}
