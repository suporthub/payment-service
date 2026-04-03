/**
 * Typed application error — carries an HTTP status code and a machine-readable
 * error code. This is what we throw throughout the service; the global error
 * handler in index.ts serialises it into the JSON response.
 */
export class AppError extends Error {
  constructor(
    public readonly code:       string,
    public readonly statusCode: number,
    message:                    string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
