/**
 * Shared configuration for auth.js and server.js.
 *
 * Both secret files default to the repository directory and are gitignored.
 * Override the locations with environment variables when the server runs
 * from somewhere else, or when several accounts share one checkout.
 *
 *   GMAIL_MCP_CREDENTIALS  path to the OAuth client JSON from Google Cloud Console
 *   GMAIL_MCP_TOKEN        path where the refresh token is stored
 *   GMAIL_MCP_ACCOUNT      optional; the address the token is expected to belong to
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));

export const CREDENTIALS = process.env.GMAIL_MCP_CREDENTIALS ?? join(DIR, 'credentials.json');
export const TOKEN = process.env.GMAIL_MCP_TOKEN ?? join(DIR, 'token.json');
export const EXPECTED_ACCOUNT = process.env.GMAIL_MCP_ACCOUNT || undefined;

// gmail.modify: read, label, draft and send. Cannot permanently delete.
export const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
