/**
 * The admin CLI's I/O seam (S32, issue #33). The program is driven through
 * injected writers and environment so the tests run the REAL command surface
 * in-process — the bin entry is a three-line adapter over process.*.
 */
export interface CliIo {
  /** stdout lines (results; the token-create display). */
  out(line: string): void;
  /** stderr lines (errors, guidance; never token material). */
  err(line: string): void;
}

export interface CliEnv {
  SHERA_ADMIN_TOKEN?: string | undefined;
  SHERA_CONTROL_PLANE_URL?: string | undefined;
  DATABASE_URL?: string | undefined;
}

export const processIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export const CLI_EXIT_OK = 0;
export const CLI_EXIT_API_ERROR = 1;
export const CLI_EXIT_USAGE = 2;
