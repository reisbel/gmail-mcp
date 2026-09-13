# gmail-mcp

A minimal [Model Context Protocol](https://modelcontextprotocol.io) server for one Gmail account, served over stdio.
It gives an MCP client such as Claude Code the ability to search, read, label, draft and send mail using your own Google OAuth client.

## Why

Google's hosted Gmail MCP endpoint only accepts a pre-registered OAuth client and rejects dynamic client registration, so generic MCP clients cannot connect to it directly.
This server sidesteps that by talking to the Gmail API itself with a Desktop-app OAuth client that you create in your own Google Cloud project.
No third party sits between the client and your mailbox.

## Scope and safety

The server requests a single scope, `gmail.modify`: read, label, draft and send.
It cannot permanently delete mail, and nothing in the tool surface bypasses Trash.

`gmail.modify` is the narrowest scope that covers marking read and archiving, since both are label mutations.
It also includes sending, so the scope alone is not the safety boundary.
The tool surface is, and sending is deliberately split in two:

- `create_draft` writes to Drafts and sends nothing. Prefer it.
- `send_message` delivers immediately and is irreversible.

Pin `send_message` to an "ask" rule in your MCP client so it prompts on every call regardless of the session's permission mode.
In Claude Code that is a line in `.claude/settings.local.json` of the project where the server is registered:

```json
{
  "permissions": {
    "ask": ["mcp__gmail__send_message"]
  }
}
```

The tool name prefix is `mcp__<server name>__`, so adjust it to whatever name you register the server under.

## Tools

| Tool | Effect |
| --- | --- |
| `search_threads` | Gmail-syntax search; returns sender, subject, date, snippet |
| `get_message` | One message in full, including plain-text body |
| `list_labels` | Label list |
| `create_draft` | Save to Drafts. Sends nothing. Threads replies via `replyToMessageId` |
| `send_message` | **Sends. Irreversible.** Pin to an ask rule |
| `mark_read` / `mark_unread` | Add or remove `UNREAD`, batched |
| `archive` / `unarchive` | Add or remove `INBOX`, batched. Reversible; deletes nothing |

## Files

| File | Purpose |
| --- | --- |
| `server.js` | The MCP server |
| `auth.js` | One-time OAuth consent flow; writes the token file |
| `config.js` | File locations and scope, overridable through environment variables |
| `credentials.json` | OAuth client from Google Cloud Console. Gitignored, never commit it |
| `token.json` | Refresh token, written with mode 600. Gitignored, never commit it |

## Setup

Requires Node.js 20 or newer.

1. In [Google Cloud Console](https://console.cloud.google.com), signed in as the Google account you want to expose: create a project and enable the **Gmail API**.
2. Configure the OAuth consent screen as **External** and add that same account as a **test user**.
3. Create an **OAuth client ID** of type **Desktop app** and download its JSON to `credentials.json` in this directory.
4. Install dependencies and run the consent flow:

   ```sh
   npm install
   npm run auth
   ```

   A browser opens on the Google consent screen.
   When it finishes, the script prints which account the token belongs to.
   Set `GMAIL_MCP_ACCOUNT` to the expected address if you want a warning when the wrong account was used.
5. Register the server with your MCP client.
   For Claude Code, from the project where you want it available:

   ```sh
   claude mcp add gmail -- node /absolute/path/to/gmail-mcp/server.js
   ```

## Configuration

Everything defaults to files next to the code.
Override with environment variables when the server runs from elsewhere or when several accounts share one checkout.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GMAIL_MCP_CREDENTIALS` | `./credentials.json` | Path to the OAuth client JSON |
| `GMAIL_MCP_TOKEN` | `./token.json` | Path where the refresh token is stored |
| `GMAIL_MCP_ACCOUNT` | unset | Expected address; `auth.js` warns if the token belongs to another account |

To change the scope, edit `SCOPES` in `config.js` and re-run `npm run auth`.
An existing token keeps its old scopes, and API calls fail with `insufficient authentication scopes` until it is reissued.

## Notes

- Staying in OAuth "Testing" status is fine for personal use; no Google verification is needed.
  Refresh tokens for unverified apps expire after 7 days of disuse, so re-run `npm run auth` if calls start failing with `invalid_grant`.
- `credentials.json` and `token.json` are secrets.
  They are gitignored here, but treat any copy of them like a password.

## License

MIT. See `LICENSE`.
