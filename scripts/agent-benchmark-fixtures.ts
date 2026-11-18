export type AgentTask = {
  id: string;
  prompt: string;
  files: Record<string, string>;
  changes: Record<string, string>;
};

export const agentTasks: AgentTask[] = [
  {
    id: "known-file",
    prompt: "把 src/export/button.ts 里的导出按钮文案从“导出 CSV”改成“下载 CSV”，只改文案。",
    files: {
      "src/export/button.ts": 'export const exportButtonLabel = "导出 CSV";\n',
      "src/export/menu.ts": 'export const exportMenuLabel = "导出 CSV";\n',
    },
    changes: {
      "src/export/button.ts": 'export const exportButtonLabel = "下载 CSV";\n',
    },
  },
  {
    id: "known-symbol",
    prompt: "把 `searchPageSize` 的默认值从 20 改为 30，不要改推荐或历史记录的分页设置。",
    files: {
      "src/search/pagination.ts": "export const searchPageSize = 20;\n",
      "src/search/history.ts": "export const historyPageSize = 20;\n",
      "src/search/recommendations.ts": "export const recommendedPageSize = 20;\n",
    },
    changes: {
      "src/search/pagination.ts": "export const searchPageSize = 30;\n",
    },
  },
  {
    id: "feature-description",
    prompt:
      "取消生成后，生成按钮还在转圈。请在取消时恢复按钮状态，保留现有的取消操作，只做必要修改。",
    files: {
      "src/generation/state.ts": "export const generationState = { loading: false };\n",
      "src/generation/request.ts": "export const generationRequest = new AbortController();\n",
      "src/generation/actions.ts":
        'import { generationRequest } from "./request.js";\n' +
        'import { generationState } from "./state.js";\n\n' +
        "export function startGeneration() {\n  generationState.loading = true;\n}\n\n" +
        "export function cancelGeneration() {\n  generationRequest.abort();\n}\n",
      "src/generation/button.ts":
        'import { generationState } from "./state.js";\n' +
        'export function renderGenerateButton() {\n  return generationState.loading ? "spinner" : "Generate";\n}\n',
    },
    changes: {
      "src/generation/actions.ts":
        'import { generationRequest } from "./request.js";\n' +
        'import { generationState } from "./state.js";\n\n' +
        "export function startGeneration() {\n  generationState.loading = true;\n}\n\n" +
        "export function cancelGeneration() {\n  generationRequest.abort();\n  generationState.loading = false;\n}\n",
    },
  },
];
