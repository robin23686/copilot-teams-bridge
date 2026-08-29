import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { chatSessionResourceFromKey } from '../../domain/chatSessionLink';
import { Bridge, describeError } from '../../application/bridge';
import type { RoutedReply } from '../../application/bridge';
import { AgencyTeamsTransport } from '../../infrastructure/transports/agencyTeamsTransport';
import { FileTransport } from '../../infrastructure/transports/fileTransport';
import { JsonThreadRegistry } from '../../infrastructure/threadRegistry';
import { JsonDeliveredRepliesRegistry, type DeliveredRepliesRegistry } from '../../infrastructure/deliveredReplies';
import type { SessionStore, ThreadedTransport } from '../../application/ports';
import type { Session } from '../../domain/types';
import { HarnessRegistry, identityOf, worthRetrying } from '../../application/services/harness';
import { summariseTurn } from '../../domain/chatTurns';
import { confirmLandedIn, revealChatSessionInEditor } from './chatReveal';
import { HoldAdapter } from './adapters/holdAdapter';
import { SidebarAdapter } from './adapters/sidebarAdapter';
import { ChatInjector } from './chatInjector';
import { describeRouting, probeHarness } from './harnessProbe';
import type { InjectionOutcome } from './chatInjector';
import { CONFIG_SECTION, currentWorkspaceName, readConfig, type BridgeConfig } from './config';
import { NotifyTool, type NotifyToolParams } from './notifyTool';
import { BridgeMcpProvider, MCP_PROVIDER_ID } from './mcpProvider';
import { ChatSessionWatcher } from './chatSessionWatcher';
import { ChatSessionResolver } from './chatSessionResolver';
import { confirmAgentHostTurn, listAgentHostSessions, workspaceStateDbPath } from './agentHostIndex';
import { AgentHostWatcher } from './agentHostWatcher';
import { isAgentHostResource, type AgentHostSession } from './agentHostSessions';
import { AgentReplyRelay } from './agentReplyRelay';
import { findBridgeServerNames } from './legacyMcpEntry';
import { announceSession, resetAnnouncements, titleFromPrompt } from './sessionStarter';
import { installInstructions, runSetup } from './setup';
import { syncCliMcpConfig } from './cliMcpConfig';

const SESSIONS_KEY = 'copilotTeamsBridge.sessions';

class MementoSessionStore implements SessionStore {
	constructor(private readonly memento: vscode.Memento) {}

	read(): Session[] {
		return this.memento.get<Session[]>(SESSIONS_KEY, []);
	}

	write(sessions: Session[]): void {
		void this.memento.update(SESSIONS_KEY, sessions);
	}
}

let bridge: Bridge | undefined;
let injector: ChatInjector;
let log: vscode.LogOutputChannel;
let statusBar: vscode.StatusBarItem;
let config: BridgeConfig;
let extensionContext: vscode.ExtensionContext;
let mcpProvider: BridgeMcpProvider | undefined;
let sessionWatcher: ChatSessionWatcher | undefined;
let agentRelay: AgentReplyRelay | undefined;
let agentHostWatcher: AgentHostWatcher | undefined;
let harnesses: HarnessRegistry;
/**
 * The one on-disk record of reply ids already handed to a chat.
 *
 * Shared between the extension's delivery path and the AgentReplyRelay so a reply the
 * other process already claimed cannot be injected a second time. See
 * {@link JsonDeliveredRepliesRegistry} for the read-then-write claim protocol.
 */
const deliveredReplies: DeliveredRepliesRegistry = new JsonDeliveredRepliesRegistry();

export function activate(context: vscode.ExtensionContext): void {
	extensionContext = context;
	log = vscode.window.createOutputChannel('Copilot Teams Bridge', { log: true });
	context.subscriptions.push(log);

	config = readConfig(context);
	injector = new ChatInjector({
		log,
		holdUnroutable: () => config.unroutableReplies === 'hold',
		// Targeting a specific chat means relocating it to an editor tab, which is visible
		// to the user, so it stays their choice rather than something done to them.
		revealChatSession: (resource, trace) =>
			config.replyTargeting === 'editorGroup'
				? revealChatSessionInEditor(resource, log, trace)
				: Promise.resolve(false),
		confirmLanded: (resource, marker) =>
			isAgentHostResource(resource)
				? // A Copilot-mode chat writes no transcript, so the usual marker search would
					// find nothing and report a false failure for every delivery. Its own tab
					// title and request timing are the evidence available for that surface.
					confirmAgentHostTurn({
						sessions: () => agentHostSessions(context),
						resource,
						writtenAt: Date.now(),
						ceilingMs: config.deliveryConfirmMs,
						activeTabLabel: () => vscode.window.tabGroups?.activeTabGroup?.activeTab?.label
					})
				: confirmLandedIn(chatSessionsUri(context), resource, marker, config.deliveryConfirmMs)
	});
	harnesses = new HarnessRegistry(
		new HoldAdapter({
			log,
			// The user's choice still decides. Holding is the safe default, but someone who
			// has opted into the focused chat must keep getting it.
			deliverAnyway: async (deliverable) =>
				config.unroutableReplies === 'focusedChat'
					? injector.inject(deliverable, mayAutoSubmit())
					: undefined
		})
	).register(new SidebarAdapter({ injector, mayAutoSubmit, log }));
	// CliRuntimeAdapter is deliberately NOT registered. See docs/known-issues.md: resuming
	// addresses a *finished* session, and a live one shares the same id, so a reply can be
	// written into a conversation another process is still holding. Detecting liveness
	// could not be verified against a running session, and an unverified safety gate is
	// worse than withholding the feature. The adapter and its tests stay so the fix has a
	// starting point.

	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = 'copilotTeamsBridge.showSessions';
	context.subscriptions.push(statusBar);

	context.subscriptions.push(
		vscode.lm.registerTool<NotifyToolParams>('copilotTeamsBridge_notify', new NotifyTool({
			bridge: () => ensureBridge(context),
			waitTimeoutMs: () => config.waitForReplyTimeoutMs,
			log
		}))
	);

	const provider = new BridgeMcpProvider(context.extensionUri, context.extension.packageJSON.version as string, () => config);
	mcpProvider = provider;
	context.subscriptions.push(provider);
	if (vscode.lm.registerMcpServerDefinitionProvider) {
		context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider));
		log.info('Registered the bundled MCP server with VS Code.');
		void warnAboutDuplicateMcpEntry(context);
	} else {
		// Older hosts still work through a hand-written mcp.json.
		log.warn('This VS Code build cannot register MCP servers from an extension; use mcp.json instead.');
	}

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration(CONFIG_SECTION)) {
				return;
			}
			config = readConfig(context);
			// Transport settings changed, so rebuild lazily on next use.
			bridge?.dispose();
			bridge = undefined;
			resetAnnouncements();
			updateStatusBar();
			// The MCP server takes its team and channel from the environment it was launched
			// with, so it has to be restarted rather than merely re-read.
			mcpProvider?.refresh();
			// The CLI runs a separate copy of the server from a JSON config, which must be
			// kept in step with the same env values, and must reflect a toggle of the
			// registerCliServer setting from true to false by removing the entry.
			syncCliMcpConfig({
				extensionUri: context.extensionUri,
				config,
				enabled: isCliServerRegistrationEnabled(),
				log
			});
			log.info('Configuration changed; the bridge will be rebuilt on next use.');
		})
	);

	registerCommands(context);
	updateStatusBar();

	startWatchers(context);

	// Keeps the guidance in step with the build. Instructions change as the bridge does, and
	// a user who ran setup once would otherwise keep the original behaviour indefinitely.
	void installInstructions({
		agencyCommand: () => config.agencyCommand,
		log,
		extensionUri: context.extensionUri,
		userInstructionsUri: userInstructionsUri(),
		agentInstructionsUri: agentInstructionsUri(),
		silent: true
	});

	// A standalone Copilot CLI session cannot see the VS Code MCP provider, so the
	// instructions we just installed would land in a runtime with no notify tool. Writing
	// the same launch spec into `~/.copilot/mcp-config.json` closes that gap and self-heals
	// after an extension version bump changes the entry file path.
	syncCliMcpConfig({
		extensionUri: context.extensionUri,
		config,
		enabled: isCliServerRegistrationEnabled(),
		log
	});

	if (config.autoStart) {
		try {
			ensureBridge(context).start();
		} catch (error) {
			log.warn(`Auto-start skipped: ${describeError(error)}`);
		}
		updateStatusBar();
	}
}

export function deactivate(): void {
	bridge?.dispose();
	bridge = undefined;
	mcpProvider = undefined;
	sessionWatcher?.dispose();
	sessionWatcher = undefined;
	agentRelay?.dispose();
	agentRelay = undefined;
}

/**
 * Starts the two things that watch for work: the transcript watcher and the agent relay.
 *
 * Kept apart from `activate` so a reset can rebuild them without a window reload. Both are
 * disposed and replaced rather than reused, because each holds a file watcher and a timer
 * that would otherwise go on running against the state that was just cleared.
 */
function startWatchers(context: vscode.ExtensionContext): void {
	// Announcing has depended on the model choosing to call the notify tool, which is
	// guidance rather than enforcement. Watching the transcripts VS Code already writes
	// makes it happen whether or not the model cooperates.
	sessionWatcher?.dispose();
	sessionWatcher = new ChatSessionWatcher({
		chatSessionsUri: chatSessionsUri(context),
		announce: (request) => announceSession({ bridge: () => ensureBridge(context), log }, request),
		log,
		minPromptLength: () => config.announceMinPromptLength,
		enabled: () => config.announceSessions,
		touch: (sessionKey) => {
			const activity = ensureBridge(context).recordActivity(sessionKey, 'chat-turn');
			if (activity?.revived) {
				// The user was told replies had stopped being read, so that has to be taken
				// back explicitly rather than the thread just quietly working again.
				void ensureBridge(context).postResumedNotice(activity.session);
			}
			// The MCP store is a separate record from the extension's memento, and a
			// session whose Teams thread was opened by the agent lives only there. Without
			// this, a chat turn in VS Code would revive the memento entry but leave the
			// MCP entry expired, so the relay would keep ignoring replies for the same
			// thread. Both paths may call postResumedNotice for the same thread; Bridge
			// keys the notice on the thread id, so exactly one resume message is posted.
			void agentRelay?.reactivate(sessionKey).then((revived) => {
				if (revived) {
					void ensureBridge(context).postResumedNotice(revived);
				}
			});
		},
		reportTurn: async (sessionKey, turn) => {
			// Milestones only: the model's own start/blocked/finished updates carry the
			// thread, and the transcript is not relayed at all.
			if (config.turnUpdates !== 'everyTurn') {
				return;
			}
			const posted = await ensureBridge(context).postTurnSummary(sessionKey, {
				requestId: turn.requestId,
				prompt: turn.prompt,
				summary: summariseTurn(turn, config.turnSummaryChars),
				startedAt: turn.startedAt
			});
			if (posted) {
				log.info(`Posted a turn summary for "${sessionKey}" to Teams`);
				updateStatusBar();
			}
		}
	});
	context.subscriptions.push(sessionWatcher);
	void sessionWatcher.start();

	// Copilot-mode chats write no transcript, so the watcher above is structurally blind to
	// them: they reached Teams only when the agent inside chose to call the notify tool.
	// VS Code's own session index is the signal that closes that gap.
	agentHostWatcher?.dispose();
	agentHostWatcher = new AgentHostWatcher({
		sessions: () => agentHostSessions(context),
		announce: (request) => announceSession({ bridge: () => ensureBridge(context), log }, request),
		touch: (sessionKey) => {
			const activity = ensureBridge(context).recordActivity(sessionKey, 'chat-turn');
			if (activity?.revived) {
				void ensureBridge(context).postResumedNotice(activity.session);
			}
		},
		enabled: () => config.announceSessions,
		intervalMs: () => config.pollIntervalMs,
		log
	});
	context.subscriptions.push(agentHostWatcher);
	agentHostWatcher.start();

	// An MCP server cannot wake an agent whose turn has ended, so a reply sat in its queue
	// until the user came back and typed something — which defeats replying from a phone.
	// The extension can open a chat request and is always running, so it delivers on the
	// server's behalf.
	// An agent session records no chat, so its reply has to be addressed by finding the
	// conversation that made the call.
	const chatSessions = new ChatSessionResolver({
		chatSessionsUri: chatSessionsUri(context),
		log,
		// A Copilot-mode chat leaves no transcript to search, so VS Code's own index is the
		// only record of it. Passed as a function because the index changes as the user works.
		agentHostSessions: () => agentHostSessions(context),
		workspacePath: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	});

	agentRelay?.dispose();
	agentRelay = new AgentReplyRelay({
		storeUri: agentStoreUri(),
		deliver: (routed) => handOver(context, routed),
		log,
		intervalMs: () => config.pollIntervalMs,
		enabled: () => config.relayAgentReplies,
		resolveChatSession: (session) => chatSessions.resolve(session),
		fetchReplies: (thread, sinceIso) => ensureBridge(context).readThread(thread, sinceIso),
		deliveredReplies,
		// Matches the Bridge's idle window so both stores expire on one rule.
		idleMs: () => config.sessionIdleMs,
		// Reuses the Bridge's expiry notice so the user sees one lifecycle message shape,
		// whichever store held the session.
		onExpired: (session) => ensureBridge(context).postExpiryNotice(session, config.sessionIdleMs)
	});
	context.subscriptions.push(agentRelay);
	agentRelay.start();
}

function registerCommands(context: vscode.ExtensionContext): void {
	const register = (id: string, handler: () => Promise<void> | void): void => {
		context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
			try {
				await handler();
			} catch (error) {
				const message = describeError(error);
				log.error(`${id} failed: ${message}`);
				const showLog = 'Show Log';
				const choice = await vscode.window.showErrorMessage(`Teams Bridge: ${message}`, showLog);
				if (choice === showLog) {
					log.show(true);
				}
			}
		}));
	};

	register('copilotTeamsBridge.resetLocalState', () => resetLocalState(context));

	register('copilotTeamsBridge.setup', async () => {
		await runSetup({
			agencyCommand: () => config.agencyCommand,
			log,
			extensionUri: context.extensionUri,
			userInstructionsUri: userInstructionsUri(),
			agentInstructionsUri: agentInstructionsUri()
		});
		// Setup writes the instructions that tell agent/CLI sessions to call the notify
		// tool, so the CLI must be given the tool at the same moment or the first CLI
		// session after setup would fail with the very error setup is meant to fix.
		syncCliMcpConfig({
			extensionUri: context.extensionUri,
			config,
			enabled: isCliServerRegistrationEnabled(),
			log
		});
	});

	const probeDeps = {
		bridge: () => ensureBridge(context),
		harnesses: () => harnesses,
		chatSessionsUri: chatSessionsUri(context),
		log
	};

	register('copilotTeamsBridge.probeHarness', () => probeHarness(probeDeps));

	register('copilotTeamsBridge.showRouting', async () => {
		const document = await vscode.workspace.openTextDocument({
			content: describeRouting(probeDeps),
			language: 'markdown'
		});
		await vscode.window.showTextDocument(document, { preview: true });
	});

	register('copilotTeamsBridge.startSession', async () => {
		const prompt = await vscode.window.showInputBox({
			prompt: 'What are you asking Copilot to do?',
			placeHolder: 'e.g. Add a solutionArea filter to the Reserve API',
			ignoreFocusOut: true
		});
		if (!prompt) {
			return;
		}
		const title = titleFromPrompt(prompt);
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Teams Bridge: opening a thread…' },
			() => announceSession({ bridge: () => ensureBridge(context), log }, { sessionKey: `session-${Date.now().toString(36)}`, title, prompt })
		);
		void vscode.window.showInformationMessage(`Teams thread opened for "${title}".`);
		updateStatusBar();
	});

	register('copilotTeamsBridge.renameSession', async () => {
		const active = ensureBridge(context);
		const sessions = active.listSessions().filter((session) => !session.closed).reverse();
		if (sessions.length === 0) {
			void vscode.window.showInformationMessage('Teams Bridge: no sessions to rename.');
			return;
		}

		const picked = await vscode.window.showQuickPick(
			sessions.map((session) => ({
				label: session.title,
				description: session.status,
				detail: `key: ${session.key}`,
				session
			})),
			{ placeHolder: 'Which session should be renamed?' }
		);
		if (!picked) {
			return;
		}

		const title = await vscode.window.showInputBox({
			prompt: 'New name for this session',
			value: picked.session.title,
			ignoreFocusOut: true
		});
		if (!title || title.trim() === picked.session.title) {
			return;
		}

		await active.renameSession(picked.session.id, title.trim());
		// Teams fixes a thread's subject at creation, so only the opening message changes.
		void vscode.window.showInformationMessage(
			`Renamed to "${title.trim()}". The Teams thread header keeps its original subject — Teams does not allow it to be changed.`
		);
		updateStatusBar();
	});

	register('copilotTeamsBridge.extendSession', async () => {
		const active = ensureBridge(context);
		const expired = active.listExpiredSessions();
		if (expired.length === 0) {
			void vscode.window.showInformationMessage('Teams Bridge: no expired sessions to extend.');
			return;
		}

		const picked = await vscode.window.showQuickPick(
			expired
				.slice()
				.reverse()
				.map((session) => ({
					label: session.title,
					description: session.status,
					detail: `key: ${session.key} · expired ${new Date(session.expiredAt as string).toLocaleString()}`,
					session
				})),
			{ placeHolder: 'Which session should start listening again?' }
		);
		if (!picked) {
			return;
		}

		const extended = active.extendSession(picked.session.id);
		if (!extended) {
			void vscode.window.showWarningMessage('That session could not be extended.');
			return;
		}
		await active.postResumedNotice(extended);
		// The MCP store is a separate record from the extension's memento, so extending
		// here must also clear the expired mark on any matching MCP entry, or the relay
		// would keep ignoring its replies. Match by the session key, which is the one
		// identifier both stores agree on.
		void agentRelay?.reactivate(extended.key);
		void vscode.window.showInformationMessage(`Teams Bridge: "${extended.title}" is listening again.`);
		updateStatusBar();
	});

	register('copilotTeamsBridge.start', () => {
		ensureBridge(context).start();
		updateStatusBar();
		void vscode.window.showInformationMessage('Teams Bridge is listening for replies.');
	});

	register('copilotTeamsBridge.stop', () => {
		bridge?.stop();
		updateStatusBar();
		void vscode.window.showInformationMessage('Teams Bridge stopped listening.');
	});

	register('copilotTeamsBridge.pollNow', async () => {
		const replies = await ensureBridge(context).poll();
		void vscode.window.showInformationMessage(`Teams Bridge: ${replies.length} new repl${replies.length === 1 ? 'y' : 'ies'}.`);
	});

	register('copilotTeamsBridge.sendTestNotification', async () => {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Teams Bridge: sending test notification…' },
			() => ensureBridge(context).notify({
				sessionKey: `test-${Date.now()}`,
				title: 'Teams Bridge test',
				summary: 'If you can read this in Teams, the bridge works. Reply in this thread and the text will land in Copilot Chat.',
				status: 'needs-input',
				question: 'Reply with anything to verify the return path.'
			})
		);
		void vscode.window.showInformationMessage('Test notification sent. Reply to it in Teams.');
		updateStatusBar();
	});


	register('copilotTeamsBridge.showSessions', async () => {
		const sessions = ensureBridge(context).listSessions().filter((session) => !session.closed).reverse();
		if (sessions.length === 0) {
			void vscode.window.showInformationMessage('Teams Bridge: no active sessions yet.');
			return;
		}
		await vscode.window.showQuickPick(
			sessions.map((session) => ({
				label: session.title,
				description: session.status,
				detail: `key: ${session.key} · last activity ${new Date(session.lastActivityAt).toLocaleString()}`
			})),
			{ placeHolder: 'Active Copilot sessions and their Teams threads' }
		);
	});
}

/**
 * Resolves VS Code's user-level instructions folder.
 *
 * globalStorageUri points at .../User/globalStorage/<extension-id>, and instruction files
 * live at .../User/prompts, so walking up two levels finds it on every platform without
 * hardcoding an OS-specific path.
 */
function userInstructionsUri(): vscode.Uri {
	const userDir = vscode.Uri.joinPath(extensionContext.globalStorageUri, '..', '..');
	return vscode.Uri.joinPath(userDir, 'prompts');
}

/**
 * Resolves the instructions folder used by agent and CLI sessions.
 *
 * These sessions do not read VS Code's prompts folder, so a file installed only there is
 * never loaded and the session is never announced to Teams.
 */
function agentInstructionsUri(): vscode.Uri | undefined {
	const home = os.homedir();
	return home ? vscode.Uri.joinPath(vscode.Uri.file(home), '.copilot', 'instructions') : undefined;
}

/**
 * Whether the CLI MCP config file should carry the bridge entry.
 *
 * Default is on: the CLI is silent without it, so opting out has to be explicit. A user
 * who has other MCP tooling and would rather manage `mcp-config.json` themselves can turn
 * this off, and the entry is removed on the next config change or activation.
 */
function isCliServerRegistrationEnabled(): boolean {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('registerCliServer', true);
}

const DUPLICATE_WARNING_KEY = 'copilotTeamsBridge.warnedDuplicateMcpEntry';

/**
 * Points out a leftover manual `mcp.json` entry for this server.
 *
 * The entry is not removed automatically: `mcp.json` is the user's own file, may hold
 * comments and unrelated servers, and rewriting it from a parsed copy would quietly
 * discard both. Warning once and opening the file leaves the edit with its owner.
 */
async function warnAboutDuplicateMcpEntry(context: vscode.ExtensionContext): Promise<void> {
	const mcpJson = vscode.Uri.joinPath(context.globalStorageUri, '..', '..', 'mcp.json');
	let text: string;
	try {
		text = Buffer.from(await vscode.workspace.fs.readFile(mcpJson)).toString('utf8');
	} catch {
		return; // No user-level mcp.json, which is the expected state.
	}

	const names = findBridgeServerNames(text);
	if (names.length === 0) {
		return;
	}

	log.warn(`Duplicate MCP entry found in mcp.json: ${names.join(', ')}. The extension now provides this server itself.`);
	if (context.globalState.get<boolean>(DUPLICATE_WARNING_KEY)) {
		return; // Already asked once; the log line above is enough thereafter.
	}
	await context.globalState.update(DUPLICATE_WARNING_KEY, true);

	const open = 'Open mcp.json';
	const choice = await vscode.window.showWarningMessage(
		`Copilot Teams Bridge now provides its MCP server automatically. Remove the "${names[0]}" entry from mcp.json, `
			+ 'otherwise two copies will poll Teams and replies can be missed.',
		open
	);
	if (choice === open) {
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mcpJson));
	}
}

/**
 * Locates the folder VS Code writes chat transcripts into.
 *
 * storageUri points at .../workspaceStorage/<workspace>/<extension-id>, and transcripts
 * live beside it under .../chatSessions, so walking up one level finds them without
 * hardcoding a path or a workspace hash.
 */
/** The MCP server's session file, which agent and CLI sessions share. */
function agentStoreUri(): vscode.Uri {
	const home = process.env.COPILOT_TEAMS_BRIDGE_HOME
		?? path.join(os.homedir(), '.copilot-teams-bridge');
	return vscode.Uri.file(path.join(home, 'sessions.json'));
}

/** The thread claim both this extension and the MCP server read, so neither duplicates. */
function threadRegistryPath(): string {
	const home = process.env.COPILOT_TEAMS_BRIDGE_HOME
		?? path.join(os.homedir(), '.copilot-teams-bridge');
	return path.join(home, 'threads.json');
}

/** The folder holding every file the extension and the MCP server share. */
function bridgeHomePath(): string {
	return process.env.COPILOT_TEAMS_BRIDGE_HOME ?? path.join(os.homedir(), '.copilot-teams-bridge');
}

/**
 * Returns the bridge to the state a fresh install would be in.
 *
 * Local state is spread across four places that no single one of them can reach: the
 * extension's own memento, the MCP server's session file, the shared thread/claim
 * registries, and in-process caches of what has already been announced. Clearing them by
 * hand is not possible while VS Code is running, because the memento lives in a SQLite
 * database the editor holds open — so the only safe place to do this is inside the
 * extension host, which is what this command is for.
 *
 * Teams threads themselves are deliberately left alone: they are the user's messages, in
 * their channel, and this bridge has no business deleting them. Forgetting the thread ids
 * means new work opens new threads, which is exactly what a new machine would do.
 */
async function resetLocalState(context: vscode.ExtensionContext): Promise<void> {
	const proceed = 'Reset';
	const choice = await vscode.window.showWarningMessage(
		'Reset all Teams Bridge local state? Sessions, threads and delivery records are forgotten, '
			+ 'as if the extension had just been installed. Existing Teams threads are left in place '
			+ 'but will no longer be linked to any session.',
		{ modal: true },
		proceed
	);
	if (choice !== proceed) {
		return;
	}

	// Stopped first so nothing is polling, delivering or persisting while the files are
	// removed — otherwise a poll in flight would write a session straight back.
	bridge?.dispose();
	bridge = undefined;
	sessionWatcher?.dispose();
	sessionWatcher = undefined;
	agentRelay?.dispose();
	agentRelay = undefined;

	const cleared: string[] = [];

	await context.globalState.update(SESSIONS_KEY, undefined);
	await context.globalState.update(DUPLICATE_WARNING_KEY, undefined);
	cleared.push('extension sessions');

	const home = bridgeHomePath();
	for (const name of ['sessions.json', 'threads.json', 'delivered.json', 'posted.json']) {
		const file = path.join(home, name);
		try {
			await vscode.workspace.fs.delete(vscode.Uri.file(file));
			cleared.push(name);
		} catch {
			// Absent already, which is the desired end state either way.
		}
	}

	// In-process caches, or the first write to an existing transcript would be treated as
	// a conversation this run had already told Teams about.
	resetAnnouncements();
	consentOffered.clear();

	// The MCP server is a separate process holding its own copy of the sessions in memory,
	// and it merges rather than overwrites — so a server left running would write its
	// stale list straight back over the file that was just cleared. Refreshing the
	// definition restarts it, and it then reads the empty store like a fresh install.
	mcpProvider?.refresh();

	log.info(`Reset local state: ${cleared.join(', ')}`);

	// Rebuilt immediately so the bridge is usable without a reload; the watcher re-seeds
	// from the transcripts on disk, so existing chats are recorded as already-seen rather
	// than announced in a burst.
	config = readConfig(context);
	startWatchers(context);
	if (config.autoStart) {
		try {
			ensureBridge(context).start();
		} catch (error) {
			log.warn(`Could not restart after reset: ${describeError(error)}`);
		}
	}
	updateStatusBar();

	void vscode.window.showInformationMessage(
		`Teams Bridge: local state reset (${cleared.length} items). New work will open new threads.`
	);
}

function chatSessionsUri(context: vscode.ExtensionContext): vscode.Uri {
	const base = context.storageUri ?? vscode.Uri.joinPath(context.globalStorageUri, '..', '..');
	return vscode.Uri.joinPath(base, '..', 'chatSessions');
}

/**
 * The Copilot-mode sessions VS Code currently knows about.
 *
 * Read on demand rather than cached: the user opens and closes these while the bridge runs,
 * and a stale list would either miss the session that made a call or offer one that has
 * gone. Every failure inside returns an empty list, which degrades to holding the reply.
 */
function agentHostSessions(context: vscode.ExtensionContext): AgentHostSession[] {
	return listAgentHostSessions({ stateDbPath: workspaceStateDbPath(chatSessionsUri(context)), log });
}

function ensureBridge(context: vscode.ExtensionContext): Bridge {
	if (bridge) {
		return bridge;
	}
	bridge = new Bridge({
		transport: createTransport(),
		store: new MementoSessionStore(context.globalState),
		// Shared with the MCP server, which keeps its own sessions in a file it cannot see
		// this memento from. Only the thread claim is shared, so one task gets one thread.
		threadRegistry: new JsonThreadRegistry(threadRegistryPath()),
		logger: log,
		pollIntervalMs: config.pollIntervalMs,
		sessionIdleMs: config.sessionIdleMs,
		expiredGraceMs: config.expiredGraceMs,
		acknowledgeReplies: config.acknowledgeReplies,
		workspace: currentWorkspaceName()
	});
	bridge.onReply(async (routed) => {
		log.info(`Teams reply for "${routed.session.title}" from ${routed.reply.from}`);
		if (routed.command && ['stop', 'close', 'done', 'cancel'].includes(routed.command)) {
			void vscode.window.showInformationMessage(`Teams Bridge: session "${routed.session.title}" closed from Teams.`);
			return;
		}
		await handOver(context, routed);
		updateStatusBar();
	});
	bridge.onSessionExpired(async (session) => {
		log.info(`Warning Teams that session "${session.title}" has paused`);
		try {
			// Posting through the transport directly, because notify() would revive the
			// session we are trying to report as expired. The window is in ms so a
			// sub-hour idle setting (used in testing) formats truthfully instead of
			// rounding down to "0 hours".
			await bridge?.postExpiryNotice(session, config.sessionIdleMs);
		} catch (error) {
			log.warn(`Could not post the expiry warning: ${describeError(error)}`);
		}
	});
	if (config.autoStart) {
		bridge.start();
	}
	// Threads opened before the shared claim existed, so the MCP server reuses them
	// instead of opening a second thread for a task already under way.
	bridge.publishThreads();
	return bridge;
}

/**
 * Fills in a chat resource that can be recovered from the session key.
 *
 * A key of the form `chat-<uuid>` was minted by the transcript watcher and literally
 * contains the chat session id. When such a session has no chatSessionResource yet, the
 * key is an authoritative source — not a guess — and using it turns an "unknown" identity
 * into a routable "vscode-sidebar" one. Left untouched when the session already names its
 * own chat: an existing exact reference must not be second-guessed by a key rewrite.
 */
function enrichWithChatFromKey(session: Session): Session {
	if (session.chatSessionResource) {
		return session;
	}
	if (session.identity?.chat?.value) {
		return session;
	}
	const recovered = chatSessionResourceFromKey(session.key);
	if (!recovered) {
		return session;
	}
	return { ...session, chatSessionResource: recovered };
}

/**
 * Hands a Teams reply to Copilot Chat and tells the user what became of it.
 *
 * Both hosts route through here so an undeliverable reply is reported the same way
 * wherever it came from — the one thing worse than a reply arriving late is one that is
 * accepted and then quietly goes nowhere.
 */
async function handOver(context: vscode.ExtensionContext, routed: RoutedReply): Promise<InjectionOutcome> {
	// The session key may itself name the chat that started the work — the transcript
	// watcher mints keys as `chat-<uuid>` — so a session that reached this bridge without
	// a chatSessionResource can still be delivered exactly rather than held. Applied
	// before routing decisions, so the identity read from the session is the enriched one.
	const enriched = enrichWithChatFromKey(routed.session);
	if (enriched !== routed.session) {
		routed = { ...routed, session: enriched };
	}
	// The identity recorded when the session started decides where this goes. Nothing here
	// searches or infers: the reply arrived on a thread, the thread names a session, and the
	// session names its own conversation.
	const identity = identityOf(routed.session);
	const adapter = harnesses.adapterFor(identity);
	const bridge = ensureBridge(context);

	// Claimed exactly once across every process sharing the registry file. A reply the
	// other delivery path already claimed must be consumed here without injecting it —
	// injecting again would repeat the user's one instruction into chat — and without
	// posting a user-facing failure notice, because nothing failed.
	if (!deliveredReplies.claim(routed.reply.id)) {
		log.info(
			`Teams reply ${routed.reply.id} for "${routed.session.title}" was already delivered by the other bridge path; consuming here.`
		);
		bridge.release(routed.session.id, routed.reply.id);
		consentOffered.delete(routed.reply.id);
		return 'delivered';
	}

	const outcome = await adapter.deliver(routed, identity);

	// The claim recorded above was pre-emptive so a concurrent process could not inject
	// the same reply in parallel. If nothing actually landed in a chat here, the claim
	// must be lifted so a later pass — in either process — can still deliver it. Without
	// this, an unroutable or transient failure tombstones the reply for good.
	if (outcome !== 'delivered' && outcome !== 'held') {
		deliveredReplies.release(routed.reply.id);
	}

	if (outcome === 'delivered' || outcome === 'held') {
		// Something acted on it, so it must stop being retried or the instruction is
		// repeated into the chat every poll.
		bridge.release(routed.session.id, routed.reply.id);
		consentOffered.delete(routed.reply.id);
		await bridge.acknowledgeReply(routed);
		return outcome;
	}
	if (outcome === 'abandoned') {
		// Terminal: an earlier attempt already told the user, and retrying would misroute
		// the same text into the same wrong chat while re-logging the identical failure.
		// The reply stays in Teams for the user to move by hand — nothing is lost — but
		// this bridge stops trying.
		bridge.release(routed.session.id, routed.reply.id);
		consentOffered.delete(routed.reply.id);
		return outcome;
	}
	if (outcome === 'unroutable') {
		// Kept rather than dropped: the reply is already marked seen, so letting it go here
		// would lose the instruction for good. Retrying costs nothing and delivers it the
		// moment the user moves to the chat it belongs to.
		if (worthRetrying(outcome, identity)) {
			bridge.retain(routed);
		}
		await bridge.postUnroutableNotice(routed);
		offerConsent(routed);
	}
	return outcome;
}

/** Replies the user has already been asked about, so a retry does not re-prompt each poll. */
const consentOffered = new Set<string>();

/**
 * Asks the user where a stranded reply should go, instead of guessing on their behalf.
 *
 * Guessing is what put one task's instruction into another task's chat, and drafting did
 * not help: `workbench.action.chat.open` writes to the focused chat whether it submits or
 * not. VS Code exposes no way to focus a specific side-bar chat — the only command taking a
 * session target moves the chat into an editor group — so the last step has to be a person.
 */
function offerConsent(routed: RoutedReply): void {
	if (consentOffered.has(routed.reply.id)) {
		return;
	}
	consentOffered.add(routed.reply.id);
	const deliver = 'Deliver to current chat';
	const copy = 'Copy';
	void vscode.window
		.showWarningMessage(
			`Teams reply for "${routed.session.title}" is waiting. It belongs to a different chat, so ` +
				`it was not sent. Click into that chat and it goes through on its own — or deliver it ` +
				`to the chat you have open now.`,
			deliver,
			copy
		)
		.then(async (choice) => {
			if (choice === deliver) {
				await injector.deliverHere(routed, mayAutoSubmit());
			} else if (choice === copy) {
				await vscode.env.clipboard.writeText(routed.text);
			}
		});
}

/**
 * Decides whether a Teams reply may be sent straight into the chat.
 *
 * A reply whose own chat could not be identified is delivered to whichever chat is focused,
 * so with several sessions running it can be acted on by a conversation that never worked
 * on that task. Auto-sending is therefore withheld while more than one session is live: the
 * reply is left in the input box for the user to check, which costs a keystroke and avoids
 * corrupting unrelated work.
 */
function mayAutoSubmit(): boolean {
	if (!config.autoSubmitReplies || config.replyDelivery === 'never') {
		return false;
	}
	if (config.replyDelivery === 'always') {
		return true;
	}
	const live = bridge?.listSessions().filter((session) => !session.closed && !session.expiredAt) ?? [];
	return live.length <= 1;
}

function createTransport(): ThreadedTransport {
	if (config.transport === 'file') {
		return new FileTransport({ directory: config.fileDirectory });
	}
	if (!config.teamId || !config.channelId) {
		throw new Error('Set copilotTeamsBridge.teamId and copilotTeamsBridge.channelId to the Teams channel you want to use.');
	}
	return new AgencyTeamsTransport({
		teamId: config.teamId,
		channelId: config.channelId,
		command: config.agencyCommand,
		mentionPolicy: config.mentionPolicy,
		logger: log
	});
}

function updateStatusBar(): void {
	const active = bridge?.listSessions().filter((session) => !session.closed).length ?? 0;
	const listening = bridge?.isListening ?? false;
	statusBar.text = `$(comment-discussion) Teams${active ? ` ${active}` : ''}`;
	statusBar.tooltip = listening
		? `Copilot Teams Bridge: listening (${active} active session${active === 1 ? '' : 's'})`
		: 'Copilot Teams Bridge: not listening';
	statusBar.show();
}




