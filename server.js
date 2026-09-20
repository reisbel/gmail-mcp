#!/usr/bin/env node
/**
 * Gmail MCP server for a single Google account, served over stdio.
 *
 * Scope is gmail.modify: read, label, draft and send. It cannot permanently
 * delete mail (no bypassing Trash).
 *
 * Sending is deliberately split in two: create_draft writes to Drafts and is
 * harmless, send_message delivers immediately. Pin send_message to an "ask"
 * permission rule in your MCP client so it always prompts (see README.md).
 */
import { readFileSync, existsSync } from 'node:fs';
import { google } from 'googleapis';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CREDENTIALS, TOKEN } from './config.js';

function gmailClient() {
  if (!existsSync(CREDENTIALS)) throw new Error(`Missing ${CREDENTIALS}. See README.md.`);
  if (!existsSync(TOKEN)) throw new Error(`Missing ${TOKEN}. Run: npm run auth`);

  const raw = JSON.parse(readFileSync(CREDENTIALS, 'utf8'));
  const cfg = raw.installed ?? raw.web ?? raw;
  const oauth2 = new google.auth.OAuth2(cfg.client_id, cfg.client_secret);
  oauth2.setCredentials(JSON.parse(readFileSync(TOKEN, 'utf8')));
  return google.gmail({ version: 'v1', auth: oauth2 });
}

const header = (headers, name) =>
  headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

const decode = (data) => Buffer.from(data, 'base64url').toString('utf8');

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Walk the MIME tree and pull out the best text body available. */
function extractBody(payload) {
  if (!payload) return '';
  if (payload.body?.data && !payload.parts) return decode(payload.body.data);

  const walk = (part, wanted) => {
    if (!part) return '';
    if (part.mimeType === wanted && part.body?.data) return decode(part.body.data);
    for (const child of part.parts ?? []) {
      const found = walk(child, wanted);
      if (found) return found;
    }
    return '';
  };

  const plain = walk(payload, 'text/plain');
  if (plain) return plain;
  const html = walk(payload, 'text/html');
  if (html) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return '';
}

/** RFC 2047 encode a header value when it is not pure ASCII. */
const encodeHeaderValue = (v) =>
  /^[\x20-\x7E]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;

/** Build an RFC 2822 message, base64url encoded for the Gmail `raw` field. */
function buildMime({ to, cc, bcc, subject, body, inReplyTo, references }) {
  const lines = [];
  if (asArray(to).length) lines.push(`To: ${asArray(to).join(', ')}`);
  if (asArray(cc).length) lines.push(`Cc: ${asArray(cc).join(', ')}`);
  if (asArray(bcc).length) lines.push(`Bcc: ${asArray(bcc).join(', ')}`);
  lines.push(`Subject: ${encodeHeaderValue(subject ?? '')}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(
    Buffer.from(body ?? '', 'utf8')
      .toString('base64')
      .replace(/(.{76})/g, '$1\r\n')
  );
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

/** Gather threading headers so a reply lands in the original conversation. */
async function replyContext(gmail, messageId) {
  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'metadata',
    metadataHeaders: ['Message-ID', 'Subject', 'References', 'From', 'Reply-To'],
  });
  const h = data.payload?.headers;
  const msgId = header(h, 'Message-ID');
  const priorRefs = header(h, 'References');
  const subject = header(h, 'Subject');
  return {
    threadId: data.threadId,
    inReplyTo: msgId || undefined,
    references: [priorRefs, msgId].filter(Boolean).join(' ') || undefined,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    replyTo: header(h, 'Reply-To') || header(h, 'From'),
  };
}

/** Shared composition path for create_draft and send_message. */
async function compose(gmail, args) {
  const { replyToMessageId, subject, body } = args;
  let { to, cc, bcc } = args;
  let threadId, inReplyTo, references, finalSubject = subject;

  if (replyToMessageId) {
    const ctx = await replyContext(gmail, replyToMessageId);
    threadId = ctx.threadId;
    inReplyTo = ctx.inReplyTo;
    references = ctx.references;
    finalSubject = subject ?? ctx.subject;
    if (!asArray(to).length) to = ctx.replyTo;
  }

  if (!asArray(to).length && !asArray(cc).length && !asArray(bcc).length) {
    throw new Error('No recipient: provide `to` (or reply with replyToMessageId).');
  }
  if (!body) throw new Error('No `body` provided.');

  const raw = buildMime({ to, cc, bcc, subject: finalSubject, body, inReplyTo, references });
  return {
    raw,
    threadId,
    summary: {
      to: asArray(to),
      cc: asArray(cc),
      bcc: asArray(bcc),
      subject: finalSubject ?? '',
      bodyPreview: body.length > 300 ? `${body.slice(0, 300)}...` : body,
    },
  };
}

const TOOLS = [
  {
    name: 'search_threads',
    description:
      'Search the Gmail account and return matching messages with sender, subject, date and snippet. ' +
      'Uses Gmail query syntax, e.g. "after:2026/09/11 -in:sent", "from:someone@example.com", "is:unread in:inbox".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query. Omit to list recent mail.' },
        maxResults: { type: 'number', description: 'Max messages to return (default 25, max 100).' },
      },
    },
  },
  {
    name: 'get_message',
    description: 'Fetch one message in full by its ID, including the plain-text body.',
    inputSchema: {
      type: 'object',
      properties: { messageId: { type: 'string', description: 'Gmail message ID.' } },
      required: ['messageId'],
    },
  },
  { name: 'list_labels', description: 'List the labels in the Gmail account.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'create_draft',
    description:
      'Compose a message and save it to Drafts WITHOUT sending. Nothing leaves the account. ' +
      'Pass replyToMessageId to draft a threaded reply (recipient and subject are inferred). Prefer this over send_message.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses.' },
        cc: { type: 'array', items: { type: 'string' } },
        bcc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain-text body.' },
        replyToMessageId: { type: 'string', description: 'Message ID to reply to, for threading.' },
      },
      required: ['body'],
    },
  },
  {
    name: 'send_message',
    description:
      'SEND a message immediately from the account. This is outward-facing and cannot be undone. ' +
      'Use create_draft unless the user has explicitly asked for the mail to be sent.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses.' },
        cc: { type: 'array', items: { type: 'string' } },
        bcc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain-text body.' },
        replyToMessageId: { type: 'string', description: 'Message ID to reply to, for threading.' },
      },
      required: ['body'],
    },
  },
  {
    name: 'mark_read',
    description: 'Mark one or more messages as read (removes the UNREAD label).',
    inputSchema: {
      type: 'object',
      properties: { messageIds: { type: 'array', items: { type: 'string' } } },
      required: ['messageIds'],
    },
  },
  {
    name: 'mark_unread',
    description: 'Mark one or more messages as unread (adds the UNREAD label).',
    inputSchema: {
      type: 'object',
      properties: { messageIds: { type: 'array', items: { type: 'string' } } },
      required: ['messageIds'],
    },
  },
  {
    name: 'archive',
    description: 'Archive one or more messages (removes INBOX). Reversible with unarchive; nothing is deleted.',
    inputSchema: {
      type: 'object',
      properties: { messageIds: { type: 'array', items: { type: 'string' } } },
      required: ['messageIds'],
    },
  },
  {
    name: 'unarchive',
    description: 'Move one or more messages back to the inbox (adds INBOX).',
    inputSchema: {
      type: 'object',
      properties: { messageIds: { type: 'array', items: { type: 'string' } } },
      required: ['messageIds'],
    },
  },
];

async function searchThreads({ query, maxResults }) {
  const gmail = gmailClient();
  const limit = Math.min(Math.max(Number(maxResults) || 25, 1), 100);
  const list = await gmail.users.messages.list({ userId: 'me', q: query || undefined, maxResults: limit });
  const ids = list.data.messages ?? [];
  if (ids.length === 0) return { count: 0, messages: [] };

  const messages = await Promise.all(
    ids.map(async ({ id }) => {
      const { data } = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });
      const h = data.payload?.headers;
      return {
        id: data.id,
        threadId: data.threadId,
        from: header(h, 'From'),
        to: header(h, 'To'),
        subject: header(h, 'Subject'),
        date: header(h, 'Date'),
        snippet: data.snippet,
        unread: (data.labelIds ?? []).includes('UNREAD'),
        labels: data.labelIds ?? [],
      };
    })
  );
  return { count: messages.length, messages };
}

async function getMessage({ messageId }) {
  const gmail = gmailClient();
  const { data } = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const h = data.payload?.headers;
  return {
    id: data.id,
    threadId: data.threadId,
    from: header(h, 'From'),
    to: header(h, 'To'),
    cc: header(h, 'Cc'),
    subject: header(h, 'Subject'),
    date: header(h, 'Date'),
    labels: data.labelIds ?? [],
    body: extractBody(data.payload),
  };
}

async function listLabels() {
  const gmail = gmailClient();
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  return { labels: (data.labels ?? []).map(({ id, name, type }) => ({ id, name, type })) };
}

async function createDraft(args) {
  const gmail = gmailClient();
  const { raw, threadId, summary } = await compose(gmail, args);
  const { data } = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } },
  });
  return { status: 'draft created (NOT sent)', draftId: data.id, messageId: data.message?.id, ...summary };
}

async function sendMessage(args) {
  const gmail = gmailClient();
  const { raw, threadId, summary } = await compose(gmail, args);
  const { data } = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, ...(threadId ? { threadId } : {}) },
  });
  return { status: 'SENT', messageId: data.id, threadId: data.threadId, ...summary };
}

/** Shared label mutation for mark_read / mark_unread / archive / unarchive. */
async function batchModify({ messageIds }, { add = [], remove = [] }, label) {
  const ids = asArray(messageIds).filter(Boolean);
  if (ids.length === 0) throw new Error('No messageIds provided.');
  const gmail = gmailClient();
  await gmail.users.messages.batchModify({
    userId: 'me',
    requestBody: { ids, addLabelIds: add, removeLabelIds: remove },
  });
  return { status: label, count: ids.length, messageIds: ids };
}

const HANDLERS = {
  search_threads: searchThreads,
  get_message: getMessage,
  list_labels: listLabels,
  create_draft: createDraft,
  send_message: sendMessage,
  mark_read: (a) => batchModify(a, { remove: ['UNREAD'] }, 'marked read'),
  mark_unread: (a) => batchModify(a, { add: ['UNREAD'] }, 'marked unread'),
  archive: (a) => batchModify(a, { remove: ['INBOX'] }, 'archived'),
  unarchive: (a) => batchModify(a, { add: ['INBOX'] }, 'moved to inbox'),
};

const server = new Server({ name: 'gmail-mcp', version: '2.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Reject arguments the tool does not declare, instead of silently dropping them.
// Without this, a call using the wrong spelling for a parameter (snake_case for a
// camelCase name, say) succeeds against the defaults and returns plausible data for
// something the caller never asked for. Silent wrong data is worse than an error.
function validateArgs(tool, args) {
  const allowed = Object.keys(tool.inputSchema?.properties ?? {});
  const canon = (k) => k.toLowerCase().replace(/[_-]/g, '');
  const unknown = Object.keys(args).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    const detail = unknown.map((k) => {
      const hit = allowed.find((a) => canon(a) === canon(k));
      return hit ? `${k} (did you mean ${hit}?)` : k;
    });
    throw new Error(
      `Unknown parameter${unknown.length > 1 ? 's' : ''}: ${detail.join(', ')}. ` +
      `${tool.name} accepts: ${allowed.join(', ') || '(none)'}.`
    );
  }
  const missing = (tool.inputSchema?.required ?? []).filter((k) => args[k] === undefined);
  if (missing.length) {
    throw new Error(`Missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const handler = HANDLERS[request.params.name];
  const tool = TOOLS.find((t) => t.name === request.params.name);
  if (!handler || !tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
  }
  try {
    const args = request.params.arguments ?? {};
    validateArgs(tool, args);
    const result = await handler(args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
