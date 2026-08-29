import * as assert from 'assert';
import { describe, it } from 'node:test';
import { cleanReplyText, isEmptyReply, parseReply, renderNotificationHtml, renderThreadSubject, shouldMentionUser } from '../src/domain/messageFormat';
import type { MentionPolicy } from '../src/domain/messageFormat';
import type { NotificationStatus, OutboundNotification } from '../src/domain/types';

const base: OutboundNotification = {
	sessionId: 's1',
	title: 'Reserve API filter',
	summary: 'Added the solutionArea filter and updated tests.',
	status: 'completed'
};

describe('renderNotificationHtml', () => {
	it('renders title, summary and reply hint for a root message', () => {
		const html = renderNotificationHtml(base, { isRoot: true });
		assert.ok(html.includes('Reserve API filter'));
		assert.ok(html.includes('Added the solutionArea filter'));
		assert.ok(html.includes('Reply in this thread'));
	});

	// A session whose chat cannot be reached still gets updates, so the thread has to say
	// that a reply will go nowhere. Otherwise the user finds out only after typing one --
	// having already spent the instruction and assumed work was continuing.
	it('warns instead of inviting a reply when replies cannot reach Copilot', () => {
		const html = renderNotificationHtml({ ...base, repliesReachChat: false }, { isRoot: true });
		assert.ok(html.includes('will not reach Copilot'), 'the thread must say replies go nowhere');
		assert.ok(html.includes('VS Code'), 'and where to give the next instruction instead');
		assert.ok(
			!html.includes('Reply in this thread to send Copilot a new instruction'),
			'it must not also invite a reply, which would contradict the warning'
		);
	});

	// The warning has to win over the stronger invitations too, or a session waiting on an
	// answer it can never receive would ask for one in bold.
	it('warns even when the session is waiting for an answer', () => {
		for (const extra of [{ awaitingReply: true }, { status: 'needs-input' as const }]) {
			const html = renderNotificationHtml({ ...base, ...extra, repliesReachChat: false }, { isRoot: true });
			assert.ok(html.includes('will not reach Copilot'), `warning must win over ${JSON.stringify(extra)}`);
			assert.ok(!html.includes('waiting for your reply'), 'and must not ask for a reply as well');
			assert.ok(!html.includes('Reply in this thread to answer'), 'nor invite one');
		}
	});

	// Undefined must keep the old behaviour, or every existing caller silently starts
	// telling users their replies do not work.
	it('still invites a reply when nothing says otherwise', () => {
		assert.ok(renderNotificationHtml(base, { isRoot: true }).includes('Reply in this thread'));
		assert.ok(renderNotificationHtml({ ...base, repliesReachChat: true }, { isRoot: true }).includes('Reply in this thread'));
	});

	// A CLI-hosted agent has no VS Code chat to open; the reply is not lost, but it also
	// will not be picked up promptly. The wording has to describe both truths so the user
	// is not misled either way.
	it('describes cli-runtime unreachability without inviting a prompt reply', () => {
		const html = renderNotificationHtml(
			{ ...base, repliesReachChat: false, unreachableHarness: 'cli-runtime' },
			{ isRoot: true }
		);

		assert.ok(html.includes('queued'), 'the reply is queued, not lost');
		assert.ok(html.includes('Copilot CLI'), 'the surface is named');
		assert.ok(html.includes('next time'), 'pickup is deferred, not immediate');
		assert.ok(html.includes('VS Code'), 'and if that agent has finished, VS Code is where to continue');
		assert.ok(!html.includes('Open this chat in VS Code'), 'a CLI session may have no chat to open');
		assert.ok(!html.includes('Reply in this thread to send Copilot a new instruction'), 'must not also invite a normal reply');
	});

	// vscode-sidebar and vscode-agent-mcp footer text has not been touched by this fix; a
	// regression would show up here as the CLI wording leaking into their branch.
	it('leaves other unreachable harnesses on the generic warning', () => {
		for (const harness of ['external', 'unknown'] as const) {
			const html = renderNotificationHtml(
				{ ...base, repliesReachChat: false, unreachableHarness: harness },
				{ isRoot: true }
			);
			assert.ok(html.includes('will not reach Copilot'), `${harness} still uses the generic wording`);
			assert.ok(!html.includes('queued for the Copilot CLI'), `${harness} must not borrow the CLI wording`);
		}
	});

	it('escapes HTML in user supplied content', () => {
		const html = renderNotificationHtml({ ...base, title: '<script>alert(1)</script>' }, { isRoot: true });
		assert.ok(!html.includes('<script>'));
		assert.ok(html.includes('&lt;script&gt;'));
	});

	it('escapes backslashes so the Agency MCP regex validator accepts the content', () => {
		// The server compiles `content` as a .NET regex and rejects `\C` as an unrecognized
		// escape. `\b` is a valid escape, so unescaped backslashes fail only sometimes.
		const html = renderNotificationHtml(
			{ ...base, summary: 'Installed to %APPDATA%\\Code\\User\\prompts\\x.md' },
			{ isRoot: true }
		);
		assert.ok(!html.includes('\\'), 'no raw backslash may reach the Agency MCP');
		assert.ok(html.includes('&#92;Code&#92;User'));
	});

	it('escapes backslashes in every user supplied field', () => {
		const html = renderNotificationHtml(
			{
				...base,
				title: 'a\\Cb',
				summary: 'c\\Cd',
				files: ['src\\Core\\file.ts'],
				question: 'e\\Cf',
				workspace: 'g\\Ch'
			},
			{ isRoot: true, mentionName: 'i\\Cj' }
		);
		assert.ok(!html.includes('\\'), 'title, summary, files, question, workspace and mention must all be escaped');
	});

	it('round-trips an escaped backslash back to a literal backslash on the way in', () => {
		assert.strictEqual(cleanReplyText('<p>%APPDATA%&#92;Code</p>'), '%APPDATA%\\Code');
	});

	it('converts markdown code spans and bold', () => {
		const html = renderNotificationHtml({ ...base, summary: 'Use `npm test` and **verify**.' }, { isRoot: true });
		assert.ok(html.includes('<code>npm test</code>'));
		assert.ok(html.includes('<b>verify</b>'));
	});

	it('lists files and truncates long lists', () => {
		const files = Array.from({ length: 25 }, (_, i) => `src/file${i}.ts`);
		const html = renderNotificationHtml({ ...base, files }, { isRoot: true });
		assert.ok(html.includes('src/file0.ts'));
		assert.ok(html.includes('and 5 more'));
	});

	it('surfaces the question and the awaiting-reply hint', () => {
		const html = renderNotificationHtml({ ...base, status: 'needs-input', question: 'Ship it?', awaitingReply: true }, { isRoot: true });
		assert.ok(html.includes('Ship it?'));
		assert.ok(html.includes('waiting for your reply'));
	});
});

describe('renderThreadSubject', () => {
	it('prefixes with Copilot and a status emoji', () => {
		assert.ok(renderThreadSubject(base).startsWith('✅ Copilot · '));
	});

	it('truncates very long titles', () => {
		const subject = renderThreadSubject({ ...base, title: 'x'.repeat(300) });
		assert.ok(subject.length < 160);
		assert.ok(subject.endsWith('…'));
	});
});

describe('cleanReplyText', () => {
	it('strips tags and decodes entities', () => {
		assert.strictEqual(cleanReplyText('<p>Ship it &amp; deploy</p>'), 'Ship it & deploy');
	});

	it('removes at-mentions at the start', () => {
		assert.strictEqual(cleanReplyText('<p><at id="0">Copilot</at> run the tests</p>'), 'run the tests');
	});

	it('drops quoted originals', () => {
		const html = '<blockquote>old message</blockquote><p>new instruction</p>';
		assert.strictEqual(cleanReplyText(html), 'new instruction');
	});

	it('preserves line structure from br and p', () => {
		assert.strictEqual(cleanReplyText('<p>one</p><p>two<br/>three</p>'), 'one\ntwo\nthree');
	});

	it('converts list items to dashes', () => {
		assert.strictEqual(cleanReplyText('<ul><li>a</li><li>b</li></ul>'), '- a\n- b');
	});

	it('handles plain text bodies', () => {
		assert.strictEqual(cleanReplyText('just text', 'text'), 'just text');
	});

	it('removes images and scripts', () => {
		assert.strictEqual(cleanReplyText('<p>hi<img src="x"><script>bad()</script></p>'), 'hi');
	});

	it('decodes numeric entities', () => {
		assert.strictEqual(cleanReplyText('<p>caf&#233;</p>'), 'café');
	});

	it('decodes the punctuation entities Teams produces', () => {
		assert.strictEqual(cleanReplyText('<p>yes &mdash; ship it&hellip;</p>'), 'yes — ship it…');
		assert.strictEqual(cleanReplyText('<p>&ldquo;quoted&rdquo; and &rsquo;s</p>'), '\u201cquoted\u201d and \u2019s');
	});

	it('leaves unknown entities untouched rather than mangling them', () => {
		assert.strictEqual(cleanReplyText('<p>&notarealentity;</p>'), '&notarealentity;');
	});
});

describe('parseReply', () => {
	it('returns plain text when there is no command', () => {
		assert.deepStrictEqual(parseReply('do the thing'), { text: 'do the thing' });
	});

	it('extracts a known command and its argument', () => {
		assert.deepStrictEqual(parseReply('/stop please'), { command: 'stop', text: 'please' });
	});

	it('ignores unknown slash words', () => {
		assert.deepStrictEqual(parseReply('/deploy now'), { text: '/deploy now' });
	});

	it('is case insensitive', () => {
		assert.strictEqual(parseReply('/STOP').command, 'stop');
	});
});

describe('isEmptyReply', () => {
	it('detects blank and whitespace-only replies', () => {
		assert.strictEqual(isEmptyReply(''), true);
		assert.strictEqual(isEmptyReply('   \n\t'), true);
		assert.strictEqual(isEmptyReply('\u200b'), true);
		assert.strictEqual(isEmptyReply('ok'), false);
	});
});

describe('shouldMentionUser', () => {
	const statuses: NotificationStatus[] = ['progress', 'completed', 'failed', 'needs-input', 'paused'];
	const policies: MentionPolicy[] = ['keyMoments', 'everyMessage', 'never'];

	function fixture(overrides: Partial<OutboundNotification> = {}): OutboundNotification {
		return { sessionId: 's1', title: 't', summary: 's', status: 'progress', ...overrides };
	}

	// The truth table catches accidental drift: the previous behaviour tagged the user on
	// every message, so a silent regression that reintroduced it would sail past a spot
	// check. Enumerating every combination makes the policy contract itself unmissable.
	it('matches the documented truth table across every policy, status and root flag', () => {
		for (const policy of policies) {
			for (const status of statuses) {
				for (const isRoot of [true, false]) {
					for (const awaitingReply of [undefined, true]) {
						const notification = fixture({ status, awaitingReply });
						const actual = shouldMentionUser(notification, isRoot, policy);
						let expected: boolean;
						if (policy === 'never') {
							expected = false;
						} else if (policy === 'everyMessage') {
							expected = true;
						} else {
							expected = isRoot || status === 'needs-input' || awaitingReply === true;
						}
						assert.strictEqual(
							actual,
							expected,
							`policy=${policy} status=${status} isRoot=${isRoot} awaitingReply=${String(awaitingReply)}`
						);
					}
				}
			}
		}
	});

	it('mentions on the root message of a thread under keyMoments', () => {
		assert.strictEqual(shouldMentionUser(fixture({ status: 'progress' }), true, 'keyMoments'), true);
	});

	it('does not mention on a progress reply into an existing thread under keyMoments', () => {
		assert.strictEqual(shouldMentionUser(fixture({ status: 'progress' }), false, 'keyMoments'), false);
	});

	it('mentions on a needs-input reply under keyMoments', () => {
		assert.strictEqual(shouldMentionUser(fixture({ status: 'needs-input' }), false, 'keyMoments'), true);
	});

	it('mentions on an awaitingReply reply under keyMoments even at status: progress', () => {
		assert.strictEqual(shouldMentionUser(fixture({ status: 'progress', awaitingReply: true }), false, 'keyMoments'), true);
	});

	it('never mentions under the never policy even for the root', () => {
		assert.strictEqual(shouldMentionUser(fixture({ status: 'needs-input' }), true, 'never'), false);
	});

	it('always mentions under everyMessage, restoring the old behaviour', () => {
		assert.strictEqual(shouldMentionUser(fixture({ status: 'completed' }), false, 'everyMessage'), true);
		assert.strictEqual(shouldMentionUser(fixture({ status: 'paused' }), false, 'everyMessage'), true);
	});
});




