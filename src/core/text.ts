const aliases: Record<string, string[]> = {
  取消: ["cancel", "abort", "stop"],
  生成: ["generate", "generation", "stream"],
  按钮: ["button", "click"],
  转圈: ["loading", "busy", "spinner"],
  加载: ["loading", "load"],
  状态: ["state", "status"],
  复位: ["reset", "clear"],
  登录: ["login", "signin", "auth"],
  认证: ["auth", "authenticate"],
  配置: ["config", "settings"],
  保存: ["save", "persist", "write"],
  删除: ["delete", "remove"],
  缓存: ["cache"],
  过期: ["expire", "expiry", "ttl"],
  重试: ["retry"],
  超时: ["timeout"],
  停止: ["stop", "abort", "cancel"],
  刷新: ["refresh", "reload"],
  文件: ["file", "files"],
  哈希: ["hash"],
  索引: ["index", "indexed", "indexing"],
  查询: ["query", "search"],
  会话: ["session"],
  消息: ["message"],
  事件: ["event", "emit", "handler"],
  路由: ["route", "router"],
  测试: ["test", "spec"],
};
const stopWords = new Set([
  "the",
  "a",
  "an",
  "is",
  "of",
  "to",
  "and",
  "for",
  "why",
  "how",
  "does",
  "in",
  "on",
  "with",
  "function",
  "const",
  "let",
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
