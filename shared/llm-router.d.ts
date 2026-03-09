export interface LlmRunOptions {
  model?: string;
  timeoutMs?: number;
  caller?: string;
  skipLog?: boolean;
  [key: string]: unknown;
}

export interface LlmRunResult {
  text: string;
  durationMs?: number;
}

export declare function runLlm(prompt: string, options?: LlmRunOptions): Promise<LlmRunResult>;
