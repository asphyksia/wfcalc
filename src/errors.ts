/**
 * An error the caller can fix: a bad weapon name, a duplicate mod, an impossible build.
 *
 * It carries a stable `code` so the CLI can exit 2 and print the JSON error contract, and the
 * HTTP API can answer 400 instead of 500. Anything without a code is a bug, not a bad request.
 */
export class InputError extends Error {
  readonly code: string;
  readonly suggestions: string[];

  constructor(message: string, code: string, suggestions: string[] = []) {
    super(message);
    this.name = 'InputError';
    this.code = code;
    this.suggestions = suggestions;
  }
}
