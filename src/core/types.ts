export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "property"
  | "struct"
  | "enum"
  | "trait"
  | "module"
  | "variant"
  | "macro"
  | "component"
  | "template";
export interface GraphSymbol {
  id: string;
  path: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  signature: string;
  summary: string;
  excerpt: string;
  document: string;
  hash: string;
  parentId?: string;
  exported: boolean;
}
export interface GraphEdge {
  source: string;
  target: string;
  kind: "calls" | "references" | "contains";
  evidence: "type-resolved" | "syntax";
  line: number;
}
export interface SourceFile {
  path: string;
  absolutePath: string;
  content: string;
  hash: string;
}
export interface FileRecord {
  path: string;
  hash: string;
}
export interface GraphStatus {
  root: string;
  files: number;
  symbols: number;
  edges: number;
  revision: number;
  indexedAt: string | null;
  changedFiles: number;
  deletedFiles: number;
  warnings: string[];
}
export interface LocateInput {
  query: string;
  scope?: string;
  limit?: number;
}
export interface LocatedSymbol {
  id: string;
  path: string;
  name: string;
  kind: SymbolKind;
  lines: [number, number];
  signature: string;
  role: "entry" | "implementation" | "state" | "consumer" | "test";
  reason: string;
  evidence: string;
  score: number;
  freshness: "current";
}
export interface LocateResult {
  query: string;
  revision: number;
  results: LocatedSymbol[];
  relations: GraphEdge[];
  warnings: string[];
  retrieval: "lexical+graph";
}
export interface InspectInput {
  id: string;
  neighbors?: number;
  maxCharacters?: number;
}
export interface InspectResult {
  symbol: Omit<GraphSymbol, "document">;
  source: string;
  truncated: boolean;
  neighbors: LocatedSymbol[];
  relations: GraphEdge[];
  revision: number;
}
export type GraphCancellation = Pick<AbortSignal, "throwIfAborted">;
export type GraphOperation = "locate" | "inspect" | "status" | "rebuild";
export interface WorkerRequest {
  id: number;
  cancellation: SharedArrayBuffer;
  operation: GraphOperation;
  input?: LocateInput | InspectInput;
}
export interface WorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
}
