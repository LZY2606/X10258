export type DiagLevel = 'error' | 'warn' | 'info';

export interface Diagnostic {
  code: string;
  level: DiagLevel;
  message: string;
  at?: string;
}

export const diag = (
  code: string,
  level: DiagLevel,
  message: string,
  at?: string,
): Diagnostic => ({ code, level, message, at });
