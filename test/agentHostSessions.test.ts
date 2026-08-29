import * as assert from 'assert';
import { describe, it } from 'node:test';
import { parseAgentHostSessions } from '../src/hosts/vscode/agentHostSessions';
import { confirmAgentHostTurn, matchAgentHostSession } from '../src/hosts/vscode/agentHostIndex';
import { asChatSessionResource, isAgentHostResource } from '../src/domain/chatSessionLink';
import type { AgentHostSession } from '../src/hosts/vscode/agentHostSessions';

/**
 * Captured verbatim from this machine's `agentSessions.model.cache`, trimmed to the
 * relevant entries. Using the real shape matters: this is another component's private
 * storage, and a hand-written approximation would keep passing after VS Code changed it.
 */
const REAL_CACHE = JSON.stringify([
	{
		providerType: 'local',
		providerLabel: 'Local',
		resource: 'vscode-chat-session://local/NjNjODA2Y2EtNjUyYi00MzY2LTlkZTgtNWJlMmFmMjNiYjc5',
		label: 'Bridge Double notification testing',
		status: 1,
		timing: { created: 1787998086489, lastRequestStarted: 1788027630407, lastRequestEnded: 1788027641244 }
	},
	{
		providerType: 'agent-host-copilotcli',
		providerLabel: 'Copilot',
		resource: 'agent-host-copilotcli:/959cbeb5-a8e5-4fd6-a798-a814bb23cc8c',
		icon: 'vm',
		label: 'Testing Bridge with Copilot Mode',
		status: 1,
		archived: false,
		isRead: true,
		timing: { created: 1788027677964, lastRequestStarted: 1788027773755, lastRequestEnded: 1788027773755 },
		changes: { files: 3, insertions: 211, deletions: 17 },
		metadata: { workingDirectoryPath: 'c:\\code\\CE-EA-ATC-Services' }
	},
	{
		providerType: 'copilotcli',
		providerLabel: 'Copilot CLI',
		resource: 'copilotcli:/0fd88ecf-3969-4949-9bc8-76fb2c0838f8',
		label: 'Investigate Bug 1300760',
		status: 1,
		timing: { created: 1782320021221, lastRequestStarted: 1782320021221, lastRequestEnded: 1782332266071 },
		metadata: { isolationMode: 'workspace', workingDirectoryPath: 'c:\\code\\Personal Work Docs' }
	}
]);

/** 11:22:53 local, the moment the real session began the request that called the tool. */
const REAL_LAST_REQUEST = 1788027773755;

function host(overrides: Partial<AgentHostSession> = {}): AgentHostSession {
	return {
		resource: 'agent-host-copilotcli:/aaaaaaaa-0000-0000-0000-000000000001',
		label: 'A Copilot-mode chat',
		workingDirectoryPath: 'c:\\code\\CE-EA-ATC-Services',
		lastRequestStarted: REAL_LAST_REQUEST,
		...overrides
	};
}

describe('reading VS Code\u2019s chat index for Copilot-mode sessions', () => {
	it('picks out only agent-host sessions from the real cache shape', () => {
		const sessions = parseAgentHostSessions(REAL_CACHE);
		assert.strictEqual(sessions.length, 1, 'local and plain-CLI sessions are other routes\u2019 business');
		assert.strictEqual(sessions[0].resource, 'agent-host-copilotcli:/959cbeb5-a8e5-4fd6-a798-a814bb23cc8c');
		assert.strictEqual(sessions[0].label, 'Testing Bridge with Copilot Mode');
		assert.strictEqual(sessions[0].workingDirectoryPath, 'c:\\code\\CE-EA-ATC-Services');
		assert.strictEqual(sessions[0].lastRequestStarted, REAL_LAST_REQUEST);
	});

	it('survives anything it does not recognise', () => {
		// This is another component's storage. Throwing here would take down reply delivery
		// for every session, not just this surface.
		for (const raw of ['', 'not json', '{}', '[]', '[null]', '[{"providerType":"agent-host-copilotcli"}]']) {
			assert.deepStrictEqual(parseAgentHostSessions(raw), [], `must tolerate ${JSON.stringify(raw)}`);
		}
	});

	it('accepts the object form as well as a bare array', () => {
		const wrapped = JSON.stringify({ version: 1, entries: JSON.parse(REAL_CACHE) });
		assert.strictEqual(parseAgentHostSessions(wrapped).length, 1);
	});
});

describe('matching a bridge session to a Copilot-mode chat', () => {
	// The notify that opened the thread, 2s before the request started in the real capture.
	const notifiedAt = new Date(REAL_LAST_REQUEST - 2_000).toISOString();

	it('matches the one session that was mid-request in the same folder', () => {
		const match = matchAgentHostSession([host()], {
			notifiedAt,
			workspacePath: 'c:\\code\\CE-EA-ATC-Services'
		});
		assert.ok(match, 'the session that was working when the tool was called');
	});

	it('refuses to choose when two sessions both fit', () => {
		// The case that matters most. Picking the closest would put one task's instruction
		// into another task's conversation; holding is visible and recoverable.
		const match = matchAgentHostSession(
			[host(), host({ resource: 'agent-host-copilotcli:/bbbbbbbb-0000-0000-0000-000000000002' })],
			{ notifiedAt, workspacePath: 'c:\\code\\CE-EA-ATC-Services' }
		);
		assert.strictEqual(match, undefined);
	});

	it('ignores a session working in a different folder', () => {
		const match = matchAgentHostSession([host({ workingDirectoryPath: 'c:\\code\\Something Else' })], {
			notifiedAt,
			workspacePath: 'c:\\code\\CE-EA-ATC-Services'
		});
		assert.strictEqual(match, undefined);
	});

	it('compares folders the way Windows means them, not the way they are spelled', () => {
		const match = matchAgentHostSession([host({ workingDirectoryPath: 'C:/code/CE-EA-ATC-Services/' })], {
			notifiedAt,
			workspacePath: 'c:\\code\\CE-EA-ATC-Services'
		});
		assert.ok(match, 'separator and case differences come from two different components');
	});

	it('ignores a session whose request started long before the notify', () => {
		const match = matchAgentHostSession([host({ lastRequestStarted: REAL_LAST_REQUEST - 60 * 60 * 1000 })], {
			notifiedAt,
			workspacePath: 'c:\\code\\CE-EA-ATC-Services'
		});
		assert.strictEqual(match, undefined, 'an hour earlier is plainly a different turn');
	});

	it('ignores a session whose request started well after the notify', () => {
		const match = matchAgentHostSession([host({ lastRequestStarted: REAL_LAST_REQUEST + 10 * 60 * 1000 })], {
			notifiedAt,
			workspacePath: 'c:\\code\\CE-EA-ATC-Services'
		});
		assert.strictEqual(match, undefined);
	});

	it('ignores an archived session', () => {
		const match = matchAgentHostSession([host({ archived: true })], {
			notifiedAt,
			workspacePath: 'c:\\code\\CE-EA-ATC-Services'
		});
		assert.strictEqual(match, undefined);
	});

	it('refuses when the bridge session has no timestamp to anchor on', () => {
		assert.strictEqual(matchAgentHostSession([host()], {}), undefined);
	});

	it('falls back to the creation time when no notify was recorded', () => {
		const match = matchAgentHostSession([host()], {
			createdAt: notifiedAt,
			workspacePath: 'c:\\code\\CE-EA-ATC-Services'
		});
		assert.ok(match);
	});
});

describe('confirming a turn ran in a Copilot-mode chat', () => {
	const resource = 'agent-host-copilotcli:/aaaaaaaa-0000-0000-0000-000000000001';

	it('confirms once that session starts a request after the write', async () => {
		let calls = 0;
		const ok = await confirmAgentHostTurn({
			resource,
			writtenAt: 1_000,
			ceilingMs: 10_000,
			pollMs: 1,
			now: () => 1_000,
			sleep: async () => undefined,
			sessions: () => {
				calls += 1;
				return [host({ resource, lastRequestStarted: calls >= 3 ? 1_500 : 900 })];
			}
		});
		assert.strictEqual(ok, true);
		assert.ok(calls >= 3, 'it must keep looking rather than judging on the first read');
	});

	it('does not accept a request that started before the write', async () => {
		let clock = 0;
		const ok = await confirmAgentHostTurn({
			resource,
			writtenAt: 5_000,
			ceilingMs: 100,
			pollMs: 10,
			now: () => (clock += 60),
			sleep: async () => undefined,
			// Stale timing from an earlier turn must not be read as proof of this one.
			sessions: () => [host({ resource, lastRequestStarted: 4_000 })]
		});
		assert.strictEqual(ok, false);
	});

	it('gives up when the session disappears from the index', async () => {
		let clock = 0;
		const ok = await confirmAgentHostTurn({
			resource,
			writtenAt: 1,
			ceilingMs: 100,
			pollMs: 10,
			now: () => (clock += 60),
			sleep: async () => undefined,
			sessions: () => []
		});
		assert.strictEqual(ok, false);
	});
});

describe('recognising and preserving a Copilot-mode resource', () => {
	it('recognises the scheme', () => {
		assert.strictEqual(isAgentHostResource('agent-host-copilotcli:/959cbeb5'), true);
		assert.strictEqual(isAgentHostResource('vscode-chat-session://local/abc'), false);
		assert.strictEqual(isAgentHostResource('959cbeb5-a8e5-4fd6-a798-a814bb23cc8c'), false);
		assert.strictEqual(isAgentHostResource(undefined), false);
	});

	// The regression this scheme would otherwise cause. `agent-host-copilotcli:/<uuid>` has
	// a single slash, so a normaliser keyed on "://" treats it as a bare chat id and
	// base64-encodes it into a resource that addresses nothing.
	it('leaves a Copilot-mode resource exactly as it is', () => {
		const resource = 'agent-host-copilotcli:/959cbeb5-a8e5-4fd6-a798-a814bb23cc8c';
		assert.strictEqual(asChatSessionResource(resource), resource);
	});

	it('still normalises a bare chat id and still leaves a local resource alone', () => {
		const local = 'vscode-chat-session://local/NjNjODA2Y2E=';
		assert.strictEqual(asChatSessionResource(local), local);

		const bare = '2ed9a15a-1420-454b-8745-cd7c78da64af';
		const encoded = asChatSessionResource(bare);
		assert.ok(encoded?.startsWith('vscode-chat-session://local/'), `expected an encoded resource, got ${encoded}`);
		assert.notStrictEqual(encoded, bare);
	});
});
