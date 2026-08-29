import * as vscode from 'vscode';
import type { Bridge } from '../../application/bridge';
import { chatSessionResourceFor } from '../../domain/chatSessionLink';
import { identityOf, repliesReachChat } from '../../application/services/harness';
import type { HarnessRegistry } from '../../application/services/harness';
import type { HarnessKind, SessionIdentity } from '../../domain/types';

export interface HarnessProbeDeps {
	bridge(): Bridge;
	harnesses(): HarnessRegistry;
	/** Folder VS Code writes chat transcripts into, one .jsonl per session. */
	chatSessionsUri: vscode.Uri;
	log: vscode.LogOutputChannel;
}

/**
 * The chat most recently written to, used as "the chat you ran this from".
 *
 * The command palette carries no chat context, so a sidebar probe launched from it would
 * record no conversation and be held — which looks like the very bug being tested for
 * rather than the palette simply not knowing. The newest transcript is the conversation
 * that was last active, which is the one the user just typed the command into.
 */
async function newestChatSession(
	chatSessionsUri: vscode.Uri,
	log: vscode.LogOutputChannel
): Promise<string | undefined> {
	try {
		const entries = await vscode.workspace.fs.readDirectory(chatSessionsUri);
		const dated = await Promise.all(
			entries
				.filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.jsonl'))
				.map(async ([name]) => {
					const uri = vscode.Uri.joinPath(chatSessionsUri, name);
					try {
						return { id: name.replace(/\.jsonl$/, ''), at: (await vscode.workspace.fs.stat(uri)).mtime };
					} catch {
						return undefined;
					}
				})
		);
		const newest = dated
			.filter((entry): entry is { id: string; at: number } => Boolean(entry))
			.sort((a, b) => b.at - a.at)[0];
		return newest ? chatSessionResourceFor(newest.id) : undefined;
	} catch (error) {
		log.debug(`Could not read chat transcripts for the probe: ${String(error)}`);
		return undefined;
	}
}

/** A harness that can be created on demand, so each one is tested deliberately. */
interface Scenario {
	kind: HarnessKind;
	label: string;
	detail: string;
	/** Whether this case is about a conversation being known, so one must be found. */
	needsChat?: boolean;
	/** Built at run time, because the sidebar case needs the chat that invoked the command. */
	identity(chatSessionResource: string | undefined): SessionIdentity;
}

const SCENARIOS: Scenario[] = [
	{
		kind: 'vscode-sidebar',
		label: 'Sidebar — this chat',
		detail: 'Identity captured exactly. A reply should land in the chat that started it.',
		needsChat: true,
		identity: (resource) => ({
			harness: 'vscode-sidebar',
			chat: resource ? { kind: 'chat-session-resource', value: resource } : undefined,
			confidence: resource ? 'exact' : 'unknown',
			capturedBy: 'notify-tool',
			capturedAt: new Date().toISOString()
		})
	},
	{
		kind: 'vscode-sidebar',
		label: 'Sidebar — chat not recorded',
		detail: 'The harness is known but the conversation is not. Should hold, never guess.',
		identity: () => ({
			harness: 'vscode-sidebar',
			confidence: 'unknown',
			capturedBy: 'notify-tool',
			capturedAt: new Date().toISOString()
		})
	},
	{
		kind: 'vscode-agent-mcp',
		label: 'Agent session (MCP)',
		detail: 'Phase 2. Runs outside VS Code, so it cannot name its own chat yet.',
		identity: () => ({
			harness: 'vscode-agent-mcp',
			confidence: 'unknown',
			capturedBy: 'mcp-ingest',
			capturedAt: new Date().toISOString()
		})
	},
	{
		kind: 'cli-runtime',
		label: 'Copilot CLI runtime',
		detail: 'Phase 3. Writes no transcript, so the thread should say replies will not reach it.',
		identity: () => ({
			harness: 'cli-runtime',
			confidence: 'unknown',
			capturedBy: 'mcp-ingest',
			capturedAt: new Date().toISOString()
		})
	},
	{
		kind: 'external',
		label: 'External client (Claude, Cursor)',
		detail: 'Another editor entirely. This window cannot deliver into it at all.',
		identity: () => ({
			harness: 'external',
			confidence: 'unknown',
			capturedBy: 'mcp-ingest',
			capturedAt: new Date().toISOString()
		})
	},
	{
		kind: 'unknown',
		label: 'Unknown harness',
		detail: 'Nothing was recorded. The safety default: hold and say so.',
		identity: () => ({
			harness: 'unknown',
			confidence: 'unknown',
			capturedBy: 'resolver',
			capturedAt: new Date().toISOString()
		})
	}
];

/**
 * Creates a real Teams thread for one harness type, so it can be tested on its own.
 *
 * Each harness is reached differently and only one is finished, so "does a reply come
 * back?" has a different right answer for each. Testing them by waiting for the situation
 * to occur naturally means waiting on someone else's session to misbehave; this makes the
 * case on demand, against the live transport, with the routing decision shown up front so a
 * wrong answer is visible immediately rather than after a reply goes missing.
 */
export async function probeHarness(deps: HarnessProbeDeps, chatSessionResource?: string): Promise<void> {
	const picked = await vscode.window.showQuickPick(
		SCENARIOS.map((scenario) => ({
			label: scenario.label,
			description: scenario.kind,
			detail: scenario.detail,
			scenario
		})),
		{ title: 'Teams Bridge: test a harness type', placeHolder: 'Which harness should this session pretend to be?' }
	);
	if (!picked) {
		return;
	}

	// Only the sidebar case needs a conversation, so the lookup is not paid for otherwise.
	const resource =
		picked.scenario.kind === 'vscode-sidebar' && picked.scenario.needsChat
			? chatSessionResource ?? (await newestChatSession(deps.chatSessionsUri, deps.log))
			: chatSessionResource;

	const identity = picked.scenario.identity(resource);
	const adapter = deps.harnesses().adapterFor(identity);
	const reachable = repliesReachChat(identity);
	const key = `harness-probe-${picked.scenario.kind}-${Date.now().toString(36)}`;

	const expectation = reachable
		? 'A reply here **should** arrive in the chat that ran this command.'
		: 'A reply here **should not** be delivered. Expect a notice, and the reply to stay in Teams.';

	const posted = await deps.bridge().notify({
		sessionKey: key,
		title: `Harness probe — ${picked.scenario.label}`,
		summary: [
			`**Testing the \`${identity.harness}\` harness.**`,
			'',
			`- Confidence: \`${identity.confidence}\``,
			`- Conversation: ${identity.chat ? `\`${identity.chat.value}\`` : '_not recorded_'}`,
			`- Adapter chosen: \`${adapter.harness}\``,
			`- Replies reach Copilot: **${reachable ? 'yes' : 'no'}**`,
			'',
			expectation
		].join('\n'),
		status: 'progress',
		identity
	});

	deps.log.info(
		`Harness probe "${picked.scenario.label}": identity=${identity.harness}/${identity.confidence}, ` +
			`adapter=${adapter.harness}, repliesReachChat=${reachable}, session=${posted.session.id}`
	);

	const open = 'Open thread';
	const choice = await vscode.window.showInformationMessage(
		`Probe posted for ${picked.scenario.label}. Adapter: ${adapter.harness}. ` +
			`Replies reach Copilot: ${reachable ? 'yes' : 'no'}.`,
		...(posted.threadUrl ? [open] : [])
	);
	if (choice === open && posted.threadUrl) {
		await vscode.env.openExternal(vscode.Uri.parse(posted.threadUrl));
	}
}

/**
 * Reports how every live session would be routed right now.
 *
 * The routing decision was previously invisible until a reply either arrived or did not,
 * which is far too late to notice it was wrong.
 */
export function describeRouting(deps: HarnessProbeDeps): string {
	const sessions = deps.bridge().listSessions().filter((session) => !session.closed);
	if (sessions.length === 0) {
		return 'No active sessions.';
	}
	return sessions
		.map((session) => {
			const identity = identityOf(session);
			const adapter = deps.harnesses().adapterFor(identity);
			const chat = identity.chat ? identity.chat.value : 'not recorded';
			return (
				`${session.title}\n` +
				`    harness  ${identity.harness} (${identity.confidence}, via ${identity.capturedBy})\n` +
				`    chat     ${chat}\n` +
				`    adapter  ${adapter.harness}\n` +
				`    replies  ${repliesReachChat(identity) ? 'reach Copilot' : 'will be held'}`
			);
		})
		.join('\n\n');
}
