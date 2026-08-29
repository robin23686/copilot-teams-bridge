import * as fs from 'fs';
import * as path from 'path';
import { cleanReplyText, renderNotificationHtml, renderThreadSubject } from '../../domain/messageFormat';
import type { ThreadedTransport } from '../../application/ports';
import type { InboundReply, OutboundNotification, PostResult, ThreadRef } from '../../domain/types';

export interface FileTransportOptions {
	/** Directory holding outbox.jsonl (Copilot -> you) and inbox.jsonl (you -> Copilot). */
	directory: string;
}

interface InboxRecord {
	id?: string;
	threadId?: string;
	text?: string;
	from?: string;
	createdAt?: string;
}

/**
 * Local loopback transport. Notifications are appended to `outbox.jsonl` and replies are
 * read from `inbox.jsonl`, which makes the full round trip testable without Teams and
 * doubles as an escape hatch for wiring up any other chat client.
 */
export class FileTransport implements ThreadedTransport {
	readonly kind = 'file' as const;
	readonly supportsReplies = true;

	private counter = 0;

	constructor(private readonly options: FileTransportOptions) {
		fs.mkdirSync(options.directory, { recursive: true });
	}

	get outboxPath(): string {
		return path.join(this.options.directory, 'outbox.jsonl');
	}

	get inboxPath(): string {
		return path.join(this.options.directory, 'inbox.jsonl');
	}

	async createThread(notification: OutboundNotification): Promise<PostResult> {
		const thread: ThreadRef = { id: `thread-${notification.sessionId}` };
		this.append(thread, notification, true);
		return { thread };
	}

	async postToThread(thread: ThreadRef, notification: OutboundNotification): Promise<PostResult> {
		const postedMessageId = this.append(thread, notification, false);
		return { thread, postedMessageId };
	}

	async fetchReplies(thread: ThreadRef, sinceIso: string | undefined): Promise<InboundReply[]> {
		if (!fs.existsSync(this.inboxPath)) {
			return [];
		}
		const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;
		const replies: InboundReply[] = [];

		for (const [index, line] of fs.readFileSync(this.inboxPath, 'utf8').split('\n').entries()) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			let record: InboxRecord;
			try {
				record = JSON.parse(trimmed) as InboxRecord;
			} catch {
				// A hand-edited inbox line is treated as a plain instruction for the thread.
				record = { text: trimmed };
			}
			if (record.threadId && record.threadId !== thread.id) {
				continue;
			}
			const createdAt = record.createdAt ?? new Date().toISOString();
			const createdMs = Date.parse(createdAt);
			if (!Number.isNaN(sinceMs) && !Number.isNaN(createdMs) && createdMs <= sinceMs) {
				continue;
			}
			replies.push({
				id: record.id ?? `inbox-${index}`,
				threadId: thread.id,
				text: cleanReplyText(record.text ?? '', 'text'),
				from: record.from ?? 'local',
				createdAt
			});
		}

		return replies.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
	}

	private append(thread: ThreadRef, notification: OutboundNotification, isRoot: boolean): string {
		const id = `out-${Date.now()}-${this.counter++}`;
		const record = {
			id,
			threadId: thread.id,
			subject: isRoot ? renderThreadSubject(notification) : undefined,
			status: notification.status,
			title: notification.title,
			html: renderNotificationHtml(notification, { isRoot }),
			createdAt: new Date().toISOString()
		};
		fs.appendFileSync(this.outboxPath, `${JSON.stringify(record)}\n`, 'utf8');
		return id;
	}
}
