import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	approveAll,
	CopilotClient,
	RuntimeConnection,
	type CopilotSession,
	type ModelInfo,
	type PermissionHandler,
	type ResumeSessionConfig,
	type SessionConfig
} from '@github/copilot-sdk';
import type { Bridge, RoutedReply } from '../../application/bridge';

export const SDK_MANAGED_SESSIONS_KEY = 'copilotTeamsBridge.sdkManagedSessions';
const MAX_TEAMS_SUMMARY = 1_500;
const TURN_TIMEOUT_MS = 30 * 60 * 1_000;

export type SdkAgentMode = 'interactive' | 'plan' | 'autopilot';
export type SdkPermissionMode = 'ask' | 'approve-all';

export interface SdkManagedSessionRecord {
	bridgeSessionId: string;
	bridgeSessionKey: string;
	sdkSessionId: string;
	title: string;
	workspace: string;
	model: string;
	agentMode: SdkAgentMode;
	permissionMode: SdkPermissionMode;
	createdAt: string;
	lastActivityAt: string;
	closed?: boolean;
}

export interface StartSdkManagedSession {
	title: string;
	prompt: string;
	model: string;
	agentMode: SdkAgentMode;
	permissionMode: SdkPermissionMode;
}

interface SdkSessionLike {
	readonly sessionId: string;
	sendAndWait(
		options: { prompt: string; mode?: 'enqueue' | 'immediate'; agentMode?: SdkAgentMode },
		timeout?: number
	): Promise<{ data: { content: string } } | undefined>;
	onError(handler: (message: string) => void): () => void;
	disconnect(): Promise<void>;
}

interface SdkClientLike {
	start(): Promise<void>;
	stop(): Promise<Error[]>;
	listModels(): Promise<ModelInfo[]>;
	createSession(config: SessionConfig): Promise<SdkSessionLike>;
	resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<SdkSessionLike>;
}

interface UserInputRequest {
	question: string;
	choices?: string[];
	allowFreeform?: boolean;
}

interface UserInputResponse {
	answer: string;
	wasFreeform: boolean;
}

export interface SdkManagedSessionsDeps {
	memento: vscode.Memento;
	bridge: () => Bridge;
	log: vscode.LogOutputChannel;
	workspacePath: () => string | undefined;
	runtimePath: () => string;
	createClient?: (runtimePath: string, workspacePath: string) => SdkClientLike;
	now?: () => Date;
}

/**
 * Owns the SDK conversations that use Teams as their user interface.
 *
 * These sessions deliberately do not pretend to be VS Code Copilot Chat sessions. The SDK
 * has no supported API for adopting one of those. Instead, one bridge session (and therefore
 * one Teams thread) maps to one SDK session id, and a Teams reply is sent to that id directly.
 */
export class SdkManagedSessions implements vscode.Disposable {
	private readonly now: () => Date;
	private readonly locks = new Map<string, Promise<void>>();
	private readonly pendingInput = new Map<string, (answer: UserInputResponse) => void>();
	private readonly activeSessions = new Map<string, SdkSessionLike>();
	private client: SdkClientLike | undefined;
	private clientPromise: Promise<SdkClientLike> | undefined;
	private disposed = false;

	constructor(private readonly deps: SdkManagedSessionsDeps) {
		this.now = deps.now ?? (() => new Date());
	}

	get records(): SdkManagedSessionRecord[] {
		return this.deps.memento
			.get<SdkManagedSessionRecord[]>(SDK_MANAGED_SESSIONS_KEY, [])
			.map((record) => ({ ...record }));
	}

	async listModels(): Promise<ModelInfo[]> {
		const client = await this.ensureClient();
		return client.listModels();
	}

	async start(request: StartSdkManagedSession): Promise<SdkManagedSessionRecord> {
		this.assertUsable();
		const workspace = this.requireWorkspace();
		const sdkSessionId = `teams-${randomUUID()}`;
		const key = `sdk-${sdkSessionId}`;
		const posted = await this.deps.bridge().notify({
			sessionKey: key,
			title: request.title,
			summary: [
				'**Teams-managed Copilot session started.**',
				'',
				`Model: \`${request.model}\` · Mode: \`${request.agentMode}\``,
				'This is an SDK-owned conversation. Its history does not appear in VS Code Copilot Chat.',
				'Reply in this thread to continue the same SDK session.'
			].join('\n'),
			status: 'progress'
		});

		const timestamp = this.now().toISOString();
		const record: SdkManagedSessionRecord = {
			bridgeSessionId: posted.session.id,
			bridgeSessionKey: key,
			sdkSessionId,
			title: request.title,
			workspace,
			model: request.model,
			agentMode: request.agentMode,
			permissionMode: request.permissionMode,
			createdAt: timestamp,
			lastActivityAt: timestamp
		};
		await this.write([...this.records, record]);

		await this.withLock(record.sdkSessionId, () => this.runTurn(record, request.prompt, true));
		return record;
	}

	/**
	 * Claims a Teams reply when its thread belongs to an SDK-owned conversation.
	 *
	 * Returning false is important: the extension's existing chat injector then receives it.
	 * Returning true prevents the same instruction being sent to both the SDK and a focused
	 * VS Code chat.
	 */
	async handleReply(routed: RoutedReply): Promise<boolean> {
		const record = this.records.find(
			(candidate) => candidate.bridgeSessionId === routed.session.id && !candidate.closed
		);
		if (!record) {
			return false;
		}

		if (routed.command && ['stop', 'close', 'done', 'cancel'].includes(routed.command)) {
			await this.update(record.sdkSessionId, { closed: true });
			this.cancelPendingInput(record.sdkSessionId);
			await this.activeSessions.get(record.sdkSessionId)?.disconnect().catch((error: unknown) => {
				this.deps.log.warn(`Copilot SDK session cancellation failed: ${describe(error)}`);
			});
			this.deps.bridge().closeSession(record.bridgeSessionId);
			return true;
		}

		const pending = this.pendingInput.get(record.sdkSessionId);
		if (pending) {
			this.pendingInput.delete(record.sdkSessionId);
			pending({ answer: routed.text, wasFreeform: true });
			await this.update(record.sdkSessionId, { lastActivityAt: this.now().toISOString() });
			return true;
		}

		void this.withLock(record.sdkSessionId, () => this.runTurn(record, routed.text, false)).catch(
			(error: unknown) => {
				this.deps.log.error(
					`Copilot SDK reply queue for "${record.title}" failed: ${describe(error)}`
				);
			}
		);
		return true;
	}

	dispose(): void {
		void this.shutdown();
	}

	async disable(): Promise<void> {
		const open = this.records.filter((record) => !record.closed);
		for (const record of open) {
			await this.update(record.sdkSessionId, { closed: true });
			this.cancelPendingInput(record.sdkSessionId);
			await this.activeSessions.get(record.sdkSessionId)?.disconnect().catch((error: unknown) => {
				this.deps.log.warn(`Copilot SDK session cancellation failed: ${describe(error)}`);
			});
			this.deps.bridge().closeSession(record.bridgeSessionId);
		}
	}

	private async shutdown(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const resolve of this.pendingInput.values()) {
			resolve({ answer: 'The SDK host stopped before an answer arrived.', wasFreeform: true });
		}
		this.pendingInput.clear();
		for (const session of this.activeSessions.values()) {
			await session.disconnect().catch(() => undefined);
		}
		this.activeSessions.clear();
		const client = this.client ?? await this.clientPromise?.catch(() => undefined);
		if (client) {
			const errors = await client.stop();
			for (const error of errors) {
				this.deps.log.warn(`Copilot SDK shutdown: ${error.message}`);
			}
			this.client = undefined;
			this.clientPromise = undefined;
		}
	}

	private async runTurn(
		record: SdkManagedSessionRecord,
		prompt: string,
		create: boolean
	): Promise<void> {
		if (this.shouldStop(record.sdkSessionId)) {
			return;
		}
		const client = await this.ensureClient();
		if (this.shouldStop(record.sdkSessionId)) {
			return;
		}
		let session: SdkSessionLike | undefined;
		let sessionError: string | undefined;
		try {
			const config = this.sessionConfig(record);
			session = create
				? await client.createSession({ ...config, sessionId: record.sdkSessionId })
				: await client.resumeSession(record.sdkSessionId, {
					...config,
					continuePendingWork: false,
					suppressResumeEvent: true
				});
			this.activeSessions.set(record.sdkSessionId, session);
			if (this.shouldStop(record.sdkSessionId)) {
				return;
			}
			session.onError((message) => {
				sessionError = message;
			});

			if (!create) {
				await this.deps.bridge().notify({
					sessionId: record.bridgeSessionId,
					sessionKey: record.bridgeSessionKey,
					title: record.title,
					summary: 'Your Teams reply reached the Copilot SDK session. Working on it now.',
					status: 'progress'
				});
			}

			const response = await session.sendAndWait(
				{ prompt, mode: 'enqueue', agentMode: record.agentMode },
				TURN_TIMEOUT_MS
			);
			if (sessionError) {
				throw new Error(sessionError);
			}
			if (this.shouldStop(record.sdkSessionId)) {
				return;
			}

			const summary = response?.data.content?.trim();
			await this.deps.bridge().notify({
				sessionId: record.bridgeSessionId,
				sessionKey: record.bridgeSessionKey,
				title: record.title,
				summary: summary
					? trimForTeams(summary)
					: 'The Copilot SDK session became idle without returning a final assistant message.',
				status: summary ? 'completed' : 'failed'
			});
			await this.update(record.sdkSessionId, { lastActivityAt: this.now().toISOString() });
		} catch (error) {
			const message = describe(error);
			this.deps.log.error(`Copilot SDK session "${record.title}" failed: ${message}`);
			if (this.shouldStop(record.sdkSessionId)) {
				return;
			}
			await this.deps.bridge().notify({
				sessionId: record.bridgeSessionId,
				sessionKey: record.bridgeSessionKey,
				title: record.title,
				summary: `The Copilot SDK session failed: ${message}`,
				status: 'failed'
			});
			if (create) {
				await this.update(record.sdkSessionId, { closed: true });
				this.deps.bridge().closeSession(record.bridgeSessionId);
			}
		} finally {
			this.activeSessions.delete(record.sdkSessionId);
			await session?.disconnect().catch((error: unknown) => {
				this.deps.log.warn(`Copilot SDK session disconnect failed: ${describe(error)}`);
			});
		}
	}

	private sessionConfig(record: SdkManagedSessionRecord): SessionConfig {
		return {
			clientName: 'copilot-teams-bridge',
			model: record.model === 'auto' ? 'auto' : record.model,
			workingDirectory: record.workspace,
			streaming: false,
			enableConfigDiscovery: true,
			skipCustomInstructions: false,
			infiniteSessions: { enabled: true },
			onPermissionRequest:
				record.permissionMode === 'approve-all'
					? approveAll
					: this.askPermission(record),
			onUserInputRequest: (request) => this.askInTeams(record, request),
			systemMessage: {
				mode: 'append',
				content: [
					'This conversation is hosted by Copilot Teams Bridge and Teams is the user interface.',
					'Use ask_user when a decision is required; the answer will arrive from the owning Teams thread.',
					'Do not call any Teams notification tool. The host publishes progress and the final response.',
					'Keep the final response concise enough to read in Teams, and include changed file paths.'
				].join(' ')
			}
		};
	}

	private askPermission(record: SdkManagedSessionRecord): PermissionHandler {
		return async (request) => {
			const detail = describePermission(request);
			const approve = 'Approve once';
			const choice = await vscode.window.showWarningMessage(
				`Copilot SDK session "${record.title}" requests permission: ${detail}`,
				{ modal: true },
				approve
			);
			return choice === approve
				? { kind: 'approve-once', approvedInteractively: true }
				: { kind: 'reject', feedback: 'The user did not approve this operation.' };
		};
	}

	private async askInTeams(
		record: SdkManagedSessionRecord,
		request: UserInputRequest
	): Promise<UserInputResponse> {
		const choices = request.choices?.length ? `\n\nChoices: ${request.choices.join(' · ')}` : '';
		await this.deps.bridge().notify({
			sessionId: record.bridgeSessionId,
			sessionKey: record.bridgeSessionKey,
			title: record.title,
			summary: 'Copilot needs your input before it can continue.',
			status: 'needs-input',
			question: `${request.question}${choices}`
		});
		return new Promise<UserInputResponse>((resolve) => {
			this.pendingInput.set(record.sdkSessionId, resolve);
		});
	}

	private async ensureClient(): Promise<SdkClientLike> {
		this.assertUsable();
		const workspace = this.requireWorkspace();
		if (this.client) {
			return this.client;
		}
		if (!this.clientPromise) {
			const runtimePath = this.deps.runtimePath().trim() || 'copilot';
			const client = this.deps.createClient
				? this.deps.createClient(runtimePath, workspace)
				: createSdkClient(runtimePath, workspace);
			this.clientPromise = client.start()
				.then(() => {
					this.client = client;
					return client;
				})
				.catch((error: unknown) => {
					this.clientPromise = undefined;
					throw error;
				});
		}
		return this.clientPromise;
	}

	private requireWorkspace(): string {
		const workspace = this.deps.workspacePath();
		if (!workspace) {
			throw new Error('Open a folder or workspace before starting a Teams-managed Copilot session.');
		}
		return workspace;
	}

	private assertUsable(): void {
		if (this.disposed) {
			throw new Error('The Copilot SDK session manager has stopped.');
		}
	}

	private isClosed(sdkSessionId: string): boolean {
		return this.records.find((record) => record.sdkSessionId === sdkSessionId)?.closed === true;
	}

	private shouldStop(sdkSessionId: string): boolean {
		return this.disposed || this.isClosed(sdkSessionId);
	}

	private cancelPendingInput(sdkSessionId: string): void {
		const pending = this.pendingInput.get(sdkSessionId);
		this.pendingInput.delete(sdkSessionId);
		pending?.({
			answer: 'The user closed this Teams-managed Copilot session.',
			wasFreeform: true
		});
	}

	private async update(
		sdkSessionId: string,
		patch: Partial<SdkManagedSessionRecord>
	): Promise<void> {
		await this.write(
			this.records.map((record) =>
				record.sdkSessionId === sdkSessionId ? { ...record, ...patch } : record
			)
		);
	}

	private async write(records: SdkManagedSessionRecord[]): Promise<void> {
		await this.deps.memento.update(SDK_MANAGED_SESSIONS_KEY, records.slice(-100));
	}

	private async withLock(sessionId: string, work: () => Promise<void>): Promise<void> {
		const previous = this.locks.get(sessionId) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(work);
		this.locks.set(sessionId, current);
		try {
			await current;
		} finally {
			if (this.locks.get(sessionId) === current) {
				this.locks.delete(sessionId);
			}
		}
	}
}

function createSdkClient(runtimePath: string, workspacePath: string): SdkClientLike {
	const client = new CopilotClient({
		mode: 'copilot-cli',
		connection: RuntimeConnection.forStdio({ path: resolveRuntimePath(runtimePath) }),
		workingDirectory: workspacePath,
		useLoggedInUser: true,
		logLevel: 'warning'
	});
	const wrap = (session: CopilotSession): SdkSessionLike => ({
		sessionId: session.sessionId,
		sendAndWait: (options, timeout) => session.sendAndWait(options, timeout),
		onError: (handler) => session.on('session.error', (event) => handler(event.data.message)),
		disconnect: () => session.disconnect()
	});
	return {
		start: () => client.start(),
		stop: () => client.stop(),
		listModels: () => client.listModels(),
		createSession: async (config) => wrap(await client.createSession(config)),
		resumeSession: async (sessionId, config) => wrap(await client.resumeSession(sessionId, config))
	};
}

export function resolveRuntimePath(configuredPath: string): string {
	if (path.dirname(configuredPath) !== '.') {
		return configuredPath;
	}
	const extensions = process.platform === 'win32'
		? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
		: [''];
	for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!directory) {
			continue;
		}
		for (const extension of extensions) {
			const candidate = path.join(directory, configuredPath + extension.toLowerCase());
			if (existsSync(candidate)) {
				return candidate;
			}
			const originalCase = path.join(directory, configuredPath + extension);
			if (originalCase !== candidate && existsSync(originalCase)) {
				return originalCase;
			}
		}
	}
	return configuredPath;
}

export function modelItems(models: ModelInfo[]): { label: string; description: string; model: string }[] {
	return [
		{ label: 'Auto (recommended)', description: 'GitHub chooses an available model for the task', model: 'auto' },
		...models
			.filter((model) => model.policy?.state !== 'disabled')
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((model) => ({
				label: model.name,
				description: model.id,
				model: model.id
			}))
	];
}

function trimForTeams(text: string): string {
	if (text.length <= MAX_TEAMS_SUMMARY) {
		return text;
	}
	const cut = text.slice(0, MAX_TEAMS_SUMMARY - 32);
	const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
	return `${(boundary > MAX_TEAMS_SUMMARY / 2 ? cut.slice(0, boundary + 1) : cut).trimEnd()}\n\n…continued in SDK session history`;
}

function describePermission(request: { kind: string }): string {
	switch (request.kind) {
		case 'shell':
			return 'run a shell command';
		case 'write':
			return 'write files';
		case 'read':
			return 'read files';
		case 'url':
			return 'access a URL';
		case 'mcp':
			return 'invoke an MCP tool';
		default:
			return request.kind;
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
