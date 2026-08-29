import * as assert from 'assert';
import { describe, it } from 'node:test';
import {
	asChatSessionResource,
	chatSessionIdFrom,
	chatSessionResourceFor,
	chatSessionResourceFromKey,
	findChatSessionFor,
	sessionKeysCalledIn
} from '../src/domain/chatSessionLink';

/**
 * A reply must reach the chat that asked for it. Sessions created through the MCP server
 * carry no chat, so the link is recovered from the transcript of the chat that called the
 * tool.
 */
describe('linking a session to its chat', () => {
	/**
	 * The live failure of 2026-08-28: two producers recorded the same conversation two
	 * different ways — the notify tool stored the full resource, the transcript watcher
	 * stored the bare id — and everything downstream parses a resource. Every reveal
	 * failed, every "is this chat in front?" comparison missed, and the user watched the
	 * same reply fail every ten seconds.
	 */
	describe('normalising a chat reference', () => {
		it('turns a bare session id into a resource', () => {
			assert.strictEqual(
				asChatSessionResource('6acd174a-6474-4814-aa89-42afe10941e9'),
				chatSessionResourceFor('6acd174a-6474-4814-aa89-42afe10941e9')
			);
		});

		it('leaves a resource untouched', () => {
			const resource = chatSessionResourceFor('abc');

			assert.strictEqual(asChatSessionResource(resource), resource);
		});

		// Both forms must name the same thing, or the comparison that decides whether a
		// chat is already in front silently fails again.
		it('makes the two recorded forms compare equal', () => {
			const fromWatcher = asChatSessionResource('session-1');
			const fromNotifyTool = asChatSessionResource(chatSessionResourceFor('session-1'));

			assert.strictEqual(fromWatcher, fromNotifyTool);
		});

		// A CLI chat is addressed under a different authority; rewriting it as local would
		// aim the reveal at a conversation that does not exist.
		it('does not rewrite the authority of another harness', () => {
			const cli = 'vscode-chat-session://copilotcli/abc';

			assert.strictEqual(asChatSessionResource(cli), cli);
		});

		it('passes through nothing when there is nothing to normalise', () => {
			assert.strictEqual(asChatSessionResource(undefined), undefined);
			assert.strictEqual(asChatSessionResource(''), undefined);
		});
	});

	it('addresses a chat the way VS Code records it', () => {
		// The expected value is one VS Code itself wrote, not one this code invented.
		assert.strictEqual(
			chatSessionResourceFor('3f9ccdc6-bb54-4acf-9d9b-1e4e552707e1'),
			'vscode-chat-session://local/M2Y5Y2NkYzYtYmI1NC00YWNmLTlkOWItMWU0ZTU1MjcwN2Ux'
		);
	});

	it('reads the chat id back out for the log', () => {
		// Again a resource VS Code wrote, so this is not just the inverse of our own encoder
		// agreeing with itself.
		assert.strictEqual(
			chatSessionIdFrom('vscode-chat-session://local/M2Y5Y2NkYzYtYmI1NC00YWNmLTlkOWItMWU0ZTU1MjcwN2Ux'),
			'3f9ccdc6-bb54-4acf-9d9b-1e4e552707e1'
		);
	});

	it('names no chat for a resource it does not recognise', () => {
		// Base64 decoding never throws, it just produces rubbish, so a bad value has to be
		// rejected rather than logged as if it were a chat id.
		assert.strictEqual(chatSessionIdFrom('file:///c:/tmp/not-a-chat'), undefined);
		assert.strictEqual(chatSessionIdFrom('vscode-chat-session://local/'), undefined);
		assert.strictEqual(chatSessionIdFrom('vscode-chat-session://local/not!base64'), undefined);
	});

	it('finds the chat that called the tool', () => {
		const transcripts = [
			{ id: 'other-chat', text: line('some-other-task') },
			{ id: 'owning-chat', text: line('icm-query-618384-investigation') }
		];

		assert.strictEqual(
			findChatSessionFor(['icm-query-618384-investigation'], transcripts),
			'owning-chat'
		);
	});

	it('ignores a chat that only quotes the key', () => {
		// A misdelivered reply names its own session in the request text, so the wrong chat's
		// transcript ends up containing the key. Matching on that would make the mistake
		// permanent, because every later reply would resolve to the chat it was last sent to.
		const quoted = JSON.stringify({
			v: { message: { text: 'This reply belongs to sessionKey "icm-query-618384-investigation"' } }
		});

		assert.strictEqual(
			findChatSessionFor(['icm-query-618384-investigation'], [{ id: 'wrong-chat', text: quoted }]),
			undefined
		);
	});

	it('prefers the newest chat when a session was resumed', () => {
		const transcripts = [
			{ id: 'newest', text: line('shared-key') },
			{ id: 'older', text: line('shared-key') }
		];

		assert.strictEqual(findChatSessionFor(['shared-key'], transcripts), 'newest');
	});

	it('matches on the session id as well as the key', () => {
		const transcripts = [{ id: 'owning-chat', text: idLine('smtc11qude58si') }];

		assert.strictEqual(findChatSessionFor(['', 'smtc11qude58si'], transcripts), 'owning-chat');
	});

	it('names no chat when none claims the session', () => {
		assert.strictEqual(findChatSessionFor(['unknown'], [{ id: 'a', text: line('other') }]), undefined);
	});

	it('reads a call whose arguments contain braces', () => {
		// A model written summary may contain a brace, so counting them naively would stop
		// reading the call halfway and lose the key.
		const text = `"rawInput":{"summary":"fixed the {handler} bug","sessionKey":"braced-key"}`;

		assert.ok(sessionKeysCalledIn(text).has('braced-key'));
	});

	it('survives a half written transcript', () => {
		assert.strictEqual(sessionKeysCalledIn('"rawInput":{"sessionKey":"trunc').size, 0);
	});

	/**
	 * A session created through the MCP server carries a key like `chat-<uuid>` when the
	 * transcript watcher was the announcer — the uuid is the chat's own session id, so it
	 * is not a search but a fact. Reading it back turns an otherwise unroutable "unknown"
	 * identity into a deliverable vscode-sidebar one, which was the live failure of
	 * 2026-08-28 where such sessions were held forever every ten seconds.
	 */
	describe('recovering a chat resource from the session key', () => {
		it('maps chat-<uuid> to the same resource VS Code writes', () => {
			const uuid = '0bc44a6c-3348-475b-a9c5-30e32a4d79dd';

			assert.strictEqual(
				chatSessionResourceFromKey(`chat-${uuid}`),
				chatSessionResourceFor(uuid),
				'the recovered resource must be exactly what the reveal command expects'
			);
		});

		it('rejects a key that does not name a chat', () => {
			// A user-picked key that happens to start with `chat-` must not be misread as a
			// chat resource, or an unrelated task would be misrouted.
			assert.strictEqual(chatSessionResourceFromKey('chat-my-task'), undefined);
			assert.strictEqual(chatSessionResourceFromKey('reserve-api-solutionarea'), undefined);
			assert.strictEqual(chatSessionResourceFromKey('chat-'), undefined);
			assert.strictEqual(chatSessionResourceFromKey(''), undefined);
			assert.strictEqual(chatSessionResourceFromKey(undefined), undefined);
		});

		it('rejects a chat- key whose tail is not a uuid', () => {
			// Otherwise a stray key of the right prefix but wrong shape would encode as a
			// resource pointing at nothing.
			assert.strictEqual(
				chatSessionResourceFromKey('chat-not-a-uuid-at-all'),
				undefined
			);
		});
	});
});

/** A recorded tool call, in the shape VS Code writes into a transcript. */
function line(sessionKey: string): string {
	return JSON.stringify({
		v: {
			toolSpecificData: { kind: 'input', rawInput: { sessionKey, title: 'Update', status: 'progress' } }
		}
	});
}

function idLine(sessionId: string): string {
	return JSON.stringify({ v: { toolSpecificData: { kind: 'input', rawInput: { sessionId } } } });
}
