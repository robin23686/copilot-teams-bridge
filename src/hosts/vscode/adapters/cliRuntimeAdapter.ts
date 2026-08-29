import type * as vscode from 'vscode';
import { canResumeCliSession, type DeliverableReply, type DeliveryOutcome, type HarnessAdapter } from '../../../application/services/harness';
import { deliveryMarker } from '../../../domain/messageFormat';
import type { SessionIdentity } from '../../../domain/types';

/** Runs a `copilot` command and reports what it printed. Injected so it can be tested. */
export interface CliRunner {
	(
		args: readonly string[],
		options: { timeoutMs: number }
	): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export interface CliRuntimeAdapterDeps {
	/**
	 * Whether the user has opted in to resuming CLI sessions.
	 *
	 * Read on every call rather than captured, so turning the setting off takes effect at
	 * once instead of at the next window reload.
	 */
	enabled(): boolean;
	run: CliRunner;
	/** Posts the agent's answer back to the thread the instruction came from. */
	report(session: DeliverableReply['session'], text: string): Promise<void>;
	/** How long a resumed run may take before it is abandoned. */
	timeoutMs(): number;
	log: vscode.LogOutputChannel;
}

/**
 * Delivers a reply by resuming the `copilot` CLI session that started the task.
 *
 * The other adapters write into a VS Code chat. A CLI session has none — it is a terminal
 * process that has already exited — so the equivalent move is to start the CLI again
 * against the same session id. `copilot --session-id <id> -p <text>` appends a turn to that
 * session with its history intact, which is the CLI's counterpart to revealing a chat and
 * submitting into it.
 *
 * **This is the one delivery route with no human in the loop.** Non-interactive mode
 * requires `--allow-all-tools`; the CLI offers no middle setting. Every other route ends
 * with text in a chat the user is looking at, where a wrong or hostile instruction is seen
 * before it does anything. Here the instruction runs unattended. That is why `enabled()`
 * gates every call and defaults to off: switching it on is a statement that everyone who
 * can post in the Teams channel is trusted to run commands on this machine.
 */
export class CliRuntimeAdapter implements HarnessAdapter {
	readonly harness = 'cli-runtime' as const;

	constructor(private readonly deps: CliRuntimeAdapterDeps) {}

	/**
	 * Only with an opt-in and a recorded session id.
	 *
	 * Asked of the identity rather than the harness, because two CLI sessions can differ:
	 * one started under a build that records the id, one not. Answering per harness would
	 * promise a route for both and hold the second forever.
	 */
	canDeliver(identity: SessionIdentity): boolean {
		return canResumeCliSession(identity, { cliResumeEnabled: this.deps.enabled() });
	}

	async deliver(deliverable: DeliverableReply, identity: SessionIdentity): Promise<DeliveryOutcome> {
		const sessionId = identity.cliSessionId;
		if (!sessionId) {
			// canDeliver already refused this, so reaching here means the registry called
			// the wrong adapter. Retained rather than failed: nothing went wrong, there is
			// simply no route.
			return 'unroutable';
		}

		// The same marker the chat route uses, so a resumed turn is recognisable as having
		// come from Teams in the CLI's own transcript exactly as it is in a chat.
		const prompt = `${deliveryMarker(deliverable.session.title, deliverable.reply.from)} ${deliverable.text}`.trim();

		this.deps.log.info(`Resuming Copilot CLI session ${sessionId} for "${deliverable.session.title}"`);

		let result: { code: number | null; stdout: string; stderr: string };
		try {
			result = await this.deps.run(
				[
					'--session-id',
					sessionId,
					'--no-remote',
					// The reply is an instruction, not a conversation: there is nobody at a
					// terminal to answer a follow-up question, so asking one would hang.
					'--no-ask-user',
					'--allow-all-tools',
					'-s',
					'-p',
					prompt
				],
				{ timeoutMs: this.deps.timeoutMs() }
			);
		} catch (error) {
			// Spawn refused outright — `copilot` missing from PATH, most likely. Transient
			// from the bridge's point of view, so the existing retry path applies.
			this.deps.log.warn(`Could not start the Copilot CLI: ${String(error)}`);
			return 'failed';
		}

		if (result.code !== 0) {
			this.deps.log.warn(
				`Copilot CLI exited with ${String(result.code)} resuming ${sessionId}: ${result.stderr.trim().slice(0, 400)}`
			);
			return 'failed';
		}

		// Nobody is watching a terminal. Without this the user sends an instruction from
		// their phone, it runs, and they see nothing — which is indistinguishable from it
		// having been ignored, and is the very failure this bridge exists to prevent.
		const answer = result.stdout.trim();
		try {
			await this.deps.report(
				deliverable.session,
				answer.length > 0 ? answer : '_The CLI session finished without printing a response._'
			);
		} catch (error) {
			// The instruction did run, so this is not a delivery failure — reporting it back
			// failed. Saying `failed` would retry the run and act on it twice.
			this.deps.log.warn(`Resumed the CLI session but could not post its answer: ${String(error)}`);
		}

		return 'delivered';
	}
}
