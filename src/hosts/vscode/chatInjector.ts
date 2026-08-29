import * as vscode from 'vscode';
import type { RoutedReply } from '../../application/bridge';
import { chatSessionIdFrom } from '../../domain/chatSessionLink';
import { deliveryMarker as sharedDeliveryMarker } from '../../domain/messageFormat';
import { beginTrace, note, writeTrace, type DeliveryTrace } from './diagnostics';

export interface ChatInjectorOptions {
	log: vscode.LogOutputChannel;
	/**
	 * Whether to keep a reply out of chat entirely when its own chat cannot be identified.
	 *
	 * See {@link ChatInjector.inject} for why the alternative is not a safe default.
	 */
	holdUnroutable?(): boolean;
	/**
	 * Brings a specific chat to the front so a request can be written to it.
	 *
	 * The only real targeting mechanism VS Code offers.
	 * `workbench.action.chat.open` cannot be told which chat to use — it always resolves
	 * `lastFocusedWidget` — but `workbench.action.chat.openSessionInEditorGroup` takes
	 * `{ resource }` and opens *that* session, focusing it.
	 *
	 * The cost is that a chat living in the side bar is relocated to an editor tab:
	 * `prepareSessionForMove` calls `clear()` on the side bar widget to detach the session.
	 * The conversation itself survives — this is exactly what the built-in "Open as Editor"
	 * action does — but the chat does leave the side bar, so it is the user's choice.
	 *
	 * Resolves true only if a chat editor is demonstrably in front afterwards.
	 */
	revealChatSession?(resource: string, trace?: DeliveryTrace): Promise<boolean>;
	/**
	 * Proves a written request actually reached the chat it was aimed at.
	 *
	 * Needed because the reveal is not self-verifying: `TabInputChat` is an empty marker
	 * class carrying no session id, so an active chat editor says *a* chat is in front and
	 * never *which*. If the reveal quietly opened the wrong thing, only the transcript of
	 * the intended session can settle it — so success is confirmed, never assumed.
	 */
	confirmLanded?(resource: string, marker: string): Promise<boolean>;
}

/** What became of a reply, which decides what the user is told about it. */
export type InjectionOutcome =
	/** Sent to the chat that started the task, or submitted as the user configured. */
	| 'delivered'
	/** Left in the chat input of the chat it belongs to, for the user to check and send. */
	| 'held'
	/** Deliberately not written anywhere, because the chat in front is not its own. */
	| 'unroutable'
	/** Copilot Chat could not be opened at all. */
	| 'failed'
	/**
	 * The automatic route has been given up on for this reply: a previous attempt revealed
	 * its chat but the write could not be proved to land there, so retrying would keep
	 * misrouting the same text into the same wrong chat. Terminal — the caller consumes
	 * the reply and tells the user exactly once, rather than logging the same explanation
	 * on every poll.
	 */
	| 'abandoned';

/**
 * Whether this reply can be written into the chat that is in front of the user.
 *
 * Drafting is not represented here, deliberately. It used to be the middle ground — an
 * unconfirmed reply was put in the input box for the user to check — and it was no safer at
 * all: `workbench.action.chat.open` writes to the *focused* chat whether it submits or
 * drafts, so `isPartialQuery` chooses whether Copilot runs, never which conversation
 * receives the text. A draft aimed at chat B still landed in chat A.
 *
 * So a reply is either written to a chat that has been *brought to the front for it*, or
 * not written at all.
 *
 * There is deliberately no `confirmed` variant. A reply whose chat is *reported* as active
 * is not proof of anything: the only signal available is transcript recency, and a target
 * whose transcript grew most recently while the user was working in a different focused
 * chat is exactly the misrouting this exists to stop. Every known target is revealed, and
 * confirmation is settled from that chat's own transcript afterwards.
 */
type Targeting =
	/** A chat is on record for this reply, so reveal it and then write. */
	| 'known'
	/** No chat recorded, so there is nothing to aim at. */
	| 'none';

/**
 * Feeds a Teams reply back into Copilot Chat as a new request.
 *
 * VS Code has no API to push a turn into an *existing* chat session. A chat can be revealed
 * first, which makes delivery correct; without that `workbench.action.chat.open` falls back
 * to the widget service's `lastFocusedWidget`, so the reply lands in whichever chat was
 * last clicked rather than the one that started the task.
 */
export class ChatInjector {
	/**
	 * Serialises deliveries, because they all compete for one focused chat.
	 *
	 * VS Code tracks a single `lastFocusedWidget` for every chat in the window, and that is
	 * what a new request is written to. Delivering therefore means moving that one pointer
	 * and immediately writing through it — an operation that cannot be safely interleaved
	 * with another delivery doing the same.
	 *
	 * What the queue does *not* need to serialise is the confirmation that follows the
	 * write. Confirmation only reads the target chat's transcript file; it touches no
	 * focus state and cannot misroute another delivery. So the queue is released once the
	 * reveal + write pair completes, and confirmation runs off it — a slow confirmation
	 * (up to two minutes on a cold chat whose agent is still starting up) is not allowed
	 * to hold up the next reply.
	 */
	private queue: Promise<void> = Promise.resolve();

	/** Replies the user chose a destination for, so a retry does not write them twice. */
	private readonly consented = new Set<string>();

	/**
	 * Replies whose reveal claimed success but whose text never arrived.
	 *
	 * Retrying those would write into the same wrong conversation again, so the automatic
	 * route is abandoned for them and the user is asked instead.
	 */
	private readonly unverifiable = new Set<string>();

	constructor(private options: ChatInjectorOptions) {}

	update(options: Partial<ChatInjectorOptions>): void {
		this.options = { ...this.options, ...options };
	}

	/**
	 * @param submit whether the request may be sent, or must be left for the user to check.
	 */
	async inject(routed: RoutedReply, submit: boolean): Promise<InjectionOutcome> {
		// Delivery is two steps that must not be split: focus the chat, then write to
		// whatever has focus. Two pollers run on their own timers and both deliver, so
		// without this a second reveal can land between the first reveal and its open —
		// and both replies go to the chat revealed last. Queuing makes the pair atomic.
		//
		// The queue only needs to hold across reveal + write. Confirmation reads a file
		// and does not touch focus state, so the next delivery is allowed to start as
		// soon as the barrier is released — see {@link revealAndWrite}.
		let releaseBarrier!: () => void;
		const barrier = new Promise<void>((resolve) => {
			releaseBarrier = resolve;
		});
		const prev = this.queue;
		this.queue = barrier;
		const turn = prev.then(async () => {
			try {
				return await this.deliverOnce(routed, submit, releaseBarrier);
			} finally {
				// A safety net: if `deliverOnce` returns or throws without releasing (any
				// path other than the confirmation one), the queue is released here so
				// later deliveries never hang on a barrier nobody armed.
				releaseBarrier();
			}
		});
		return turn;
	}

	private async deliverOnce(
		routed: RoutedReply,
		submit: boolean,
		releaseQueue: () => void
	): Promise<InjectionOutcome> {
		const trace = beginTrace(routed.session.title, routed.reply.id);
		trace.storedChat = routed.session.chatSessionResource;
		trace.resource = routed.session.chatSessionResource;

		const outcome = await this.decide(routed, submit, releaseQueue, trace);
		writeTrace(this.options.log, trace, outcome);
		return outcome;
	}

	private async decide(
		routed: RoutedReply,
		submit: boolean,
		releaseQueue: () => void,
		trace: DeliveryTrace
	): Promise<InjectionOutcome> {
		// Already written by the user taking responsibility for it, so writing again would
		// duplicate the instruction in whatever chat is now in front.
		if (this.consented.has(routed.reply.id)) {
			note(trace, 'alreadyConsented');
			return 'delivered';
		}

		const targeting: Targeting = routed.session.chatSessionResource ? 'known' : 'none';
		note(trace, `targeting=${targeting}`);

		// Nothing recorded to aim at. Revealing is impossible, so this is the only case that
		// still turns on the user's own preference for guessing.
		if (targeting === 'none') {
			if (this.options.holdUnroutable?.()) {
				this.explain(routed, targeting);
				return 'unroutable';
			}
			return this.write(routed, 'guessed', submit, trace);
		}

		// A known chat is *always* revealed before writing, even when some other signal
		// claims it is already the one in front. Transcript recency is the only such signal
		// available, and a target whose transcript grew most recently while the user was
		// working in a different focused chat is exactly the misrouting this exists to stop.
		return this.revealAndWrite(routed, targeting, releaseQueue, trace);
	}

	/**
	 * Brings the reply's own chat to the front, writes to it, and proves it arrived.
	 *
	 * Each step gates the next. Writing before the reveal succeeds would put the text in
	 * whichever chat happened to be focused, which is the misrouting this exists to stop;
	 * and reporting success before the transcript confirms it would repeat the older bug of
	 * a reply logged as delivered to a chat it never reached.
	 */
	private async revealAndWrite(
		routed: RoutedReply,
		targeting: Targeting,
		releaseQueue: () => void,
		trace: DeliveryTrace
	): Promise<InjectionOutcome> {
		const resource = routed.session.chatSessionResource;
		// Already given up on: on an earlier attempt the reveal reported success and the
		// text did not arrive, so retrying would write into the same wrong conversation and
		// re-log the identical failure. Terminal so the caller consumes it once, rather than
		// carrying on until VS Code is restarted.
		if (this.unverifiable.has(routed.reply.id)) {
			note(
				trace,
				`cannotSteer(resource=${Boolean(resource)} steering=${Boolean(this.options.revealChatSession)} ` +
					`givenUp=true)`
			);
			return 'abandoned';
		}
		if (!resource || !this.options.revealChatSession) {
			note(
				trace,
				`cannotSteer(resource=${Boolean(resource)} steering=${Boolean(this.options.revealChatSession)} ` +
					`givenUp=false)`
			);
			this.explain(routed, targeting);
			return 'unroutable';
		}

		if (!(await this.options.revealChatSession(resource, trace))) {
			note(trace, 'revealFailed');
			this.options.log.info(
				`Could not bring the chat for "${routed.session.title}" to the front, so nothing was ` +
					`written. The reply is kept and tried again.`
			);
			return 'unroutable';
		}
		note(trace, 'revealed');

		const outcome = await this.write(routed, 'revealed', true, trace);
		if (outcome !== 'delivered') {
			return outcome;
		}

		// Reveal + write is done: the focus pointer has moved and the request is on VS
		// Code's queue. Confirmation from here on only reads a file, so the next delivery
		// is allowed to start rather than waiting up to a couple of minutes on a cold chat.
		releaseQueue();

		if (!this.options.confirmLanded || (await this.options.confirmLanded(resource, deliveryMarker(routed)))) {
			note(trace, 'landingConfirmed');
			return 'delivered';
		}

		// The reveal reported success and the text still did not arrive, so the chat that
		// received it was not this one. Not retried: another attempt would write into that
		// same wrong conversation again.
		this.unverifiable.add(routed.reply.id);
		note(trace, 'landingUnconfirmed');
		this.options.log.warn(
			`The Teams reply for "${routed.session.title}" was written after revealing its chat, but ` +
				`that chat's transcript does not show it. Treating it as not delivered rather than ` +
				`claiming a delivery that cannot be proved.`
		);
		return 'unroutable';
	}

	/** Writes the request to whatever chat is in front, having established which that is. */
	private async write(
		routed: RoutedReply,
		mode: 'revealed' | 'guessed',
		submit: boolean,
		trace?: DeliveryTrace
	): Promise<InjectionOutcome> {
		const query = buildQuery(routed, mode);
		if (!(await this.openChat(query, !submit))) {
			note(trace, 'chatOpenFailed');
			await this.fallback(query);
			return 'failed';
		}
		note(trace, `wrote(mode=${mode} submitted=${submit})`);

		if (submit) {
			this.options.log.info(`Injected Teams reply into ${this.describeTarget(routed, mode === 'revealed')}`);
			return 'delivered';
		}

		this.options.log.info(`Held Teams reply for session "${routed.session.title}" in the chat input`);
		void this.confirm(routed, query);
		return 'held';
	}

	/**
	 * Writes a stranded reply into whatever chat is focused, because the user said to.
	 *
	 * The same operation the automatic path refuses, and the difference is consent rather
	 * than mechanism: a person who has just been told which task the reply belongs to, and
	 * has put the chat they want in front, is choosing the destination. Guessing on their
	 * behalf is what put one task's instruction into another task's conversation.
	 */
	async deliverHere(routed: RoutedReply, submit: boolean): Promise<void> {
		const query = buildQuery(routed, 'consented');
		this.consented.add(routed.reply.id);
		if (await this.openChat(query, !submit)) {
			this.options.log.info(
				`Delivered the Teams reply for "${routed.session.title}" into the focused chat at the user's request`
			);
			return;
		}
		this.consented.delete(routed.reply.id);
		await this.fallback(query);
	}

	/** Says why a reply was not written, so routing can be read from the log by itself. */
	private explain(routed: RoutedReply, targeting: Targeting): void {
		const title = routed.session.title;
		if (targeting === 'known') {
			this.options.log.info(
				`Not writing the Teams reply for "${title}": its chat could not be brought forward, so ` +
					`writing would put it in the wrong conversation.`
			);
			return;
		}
		this.options.log.warn(
			`Not writing the Teams reply for "${title}": no chat is recorded for it, and the focused ` +
				`chat is not a safe guess.`
		);
	}

	/** Names the chat a reply went to, so routing can be read from the log by itself. */
	private describeTarget(routed: RoutedReply, targeted: boolean): string {
		const suffix = ` for session "${routed.session.title}"`;
		if (!targeted) {
			return `the focused chat, whichever that is,${suffix}`;
		}
		const resource = routed.session.chatSessionResource;
		const id = resource ? chatSessionIdFrom(resource) : undefined;
		return `the originating chat ${id ?? resource}${suffix}`;
	}

	/** Tells the user a reply is waiting, since an unsent draft is easy to miss. */
	private async confirm(routed: RoutedReply, query: string): Promise<void> {
		const copy = "Copy instead";
		const choice = await vscode.window.showInformationMessage(
			`Teams reply for "${routed.session.title}" is waiting in the chat input. ` +
				`Check it is the right chat, then send it.`,
			copy
		);
		if (choice === copy) {
			await vscode.env.clipboard.writeText(query);
		}
	}

	private async openChat(query: string, isPartialQuery: boolean): Promise<boolean> {
		try {
			await vscode.commands.executeCommand('workbench.action.chat.open', { query, isPartialQuery });
			return true;
		} catch (error) {
			this.options.log.warn(`workbench.action.chat.open failed: ${String(error)}`);
		}

		try {
			await vscode.commands.executeCommand('workbench.action.chat.open', query);
			return true;
		} catch (error) {
			this.options.log.warn(`Chat open fallback failed: ${String(error)}`);
			return false;
		}
	}

	/** Last resort: keep the instruction recoverable instead of dropping it. */
	private async fallback(query: string): Promise<void> {
		await vscode.env.clipboard.writeText(query);
		const action = await vscode.window.showWarningMessage(
			'Copilot Teams Bridge could not open Copilot Chat. The Teams reply was copied to your clipboard.',
			'Show Log'
		);
		if (action === 'Show Log') {
			this.options.log.show(true);
		}
	}
}

/**
 * The line that identifies a delivered request in a transcript.
 *
 * Doubles as the proof of delivery: it names the session and the sender, so finding it in
 * a given chat's transcript is what confirms the request reached *that* chat.
 */
function deliveryMarker(routed: RoutedReply): string {
	return sharedDeliveryMarker(routed.session.title, routed.reply.from);
}

/**
 * Builds the request text handed to Copilot Chat.
 *
 * A reply can arrive in a chat that never worked on the task, so the text has to say so:
 * telling an unrelated conversation to "pick the work back up from where it left off"
 * invites it to invent continuity for work it never did.
 */
function buildQuery(routed: RoutedReply, mode: 'revealed' | 'consented' | 'guessed'): string {
	const lines = [deliveryMarker(routed), '', routed.text, ''];

	if (mode === 'consented') {
		lines.push(
			`This reply belongs to the task "${routed.session.title}", and was placed here because you ` +
				`asked for it to go to the chat in front of you.`,
			'',
			`**If this conversation has not been working on "${routed.session.title}", say so and stop.**`
		);
	} else if (mode === 'guessed') {
		lines.push(
			`This reply belongs to the task "${routed.session.title}", and could not be delivered to a ` +
				`specific chat, so it may have arrived in the wrong one.`,
			'',
			`**If this conversation has not been working on "${routed.session.title}", say so and stop.** ` +
				`Do not act on the instruction as though you have that context, and do not guess what the ` +
				`task was — tell the user which chat it belongs to so they can move it.`
		);
	}

	if (routed.command === 'status') {
		lines.push(
			'',
			`If it *is* your task, report its current status back to Teams with the ` +
				`copilotTeamsBridge_notify tool using sessionKey "${routed.session.key}".`
		);
	} else {
		lines.push(
			'',
			`If it *is* your task, this continues it rather than starting something new: pick the work ` +
				`back up and report progress with the copilotTeamsBridge_notify tool using sessionKey ` +
				`"${routed.session.key}" so updates stay in the same Teams thread.`
		);
	}

	return lines.join('\n');
}
