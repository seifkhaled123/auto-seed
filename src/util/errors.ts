/**
 * Exit codes per PRD §6.4:
 *   0 success
 *   1 user / config error
 *   2 schema parse error
 *   3 LLM / API error
 *   4 generation / integrity error
 */
export type ExitCode = 0 | 1 | 2 | 3 | 4;

export class CLIError extends Error {
  readonly exitCode: ExitCode;
  readonly hint?: string;

  constructor(message: string, exitCode: ExitCode = 1, hint?: string) {
    super(message);
    this.name = "CLIError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export function isCLIError(err: unknown): err is CLIError {
  return err instanceof CLIError;
}
