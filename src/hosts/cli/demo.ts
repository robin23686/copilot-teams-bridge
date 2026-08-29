import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Bridge, type RoutedReply } from '../../application/bridge';
import { AgencyTeamsTransport } from '../../infrastructure/transports/agencyTeamsTransport';
import { FileTransport } from '../../infrastructure/transports/fileTransport';
import type { SessionStore, ThreadedTransport } from '../../application/ports';
import type { NotificationStatus, Session } from '../../domain/types';

/**
 * Command line harness for the bridge.
 *
 * Useful for verifying a setup without installing the extension or wiring up an MCP
 * client, and for scripted notifications from CI or hooks.
 */

const HOME = process.env.COPILOT_TEAMS_BRIDGE_HOME ?? path.join(os.homedir(), '.copilot-teams-bridge');

class JsonSessionStore implements SessionStore {
	constructor(private readonly file: string) {}

	read(): Session[] {
		try {
			return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Session[];
		} catch {
			return [];
		}
	}

	write(sessions: Session[]): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		fs.writeFileSync(this.file, JSON.stringify(sessions, null, 2), 'utf8');
	}
}

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command: string; flags: Flags } {
	const [command = 'help', ...rest] = argv;
	const flags: Flags = {};
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (!token.startsWith('--')) {
			continue;
		}
		const key = token.slice(2);
		const next = rest[i + 1];
		if (next && !next.startsWith('--')) {
			flags[key] = next;
			i++;
		} else {
			flags[key] = true;
		}
	}
	return { command, flags };
}

function str(flags: Flags, key: string, fallback = ''): string {
	const value = flags[key];
	return typeof value === 'string' ? value : fallback;
}

function consoleLogger(): { info(m: string): void; warn(m: string): void; error(m: string): void } {
	return {
		info: (m: string) => console.log(`  ${m}`),
		warn: (m: string) => console.warn(`  ${m}`),
		error: (m: string) => console.error(`  ${m}`)
	};
}

function makeTransport(flags: Flags): ThreadedTransport {
	if (str(flags, 'transport') === 'file') {
		return new FileTransport({ directory: str(flags, 'dir', path.join(HOME, 'inbox')) });
	}
	const teamId = str(flags, 'team', process.env.COPILOT_TEAMS_BRIDGE_TEAM ?? '');
	const channelId = str(flags, 'channel', process.env.COPILOT_TEAMS_BRIDGE_CHANNEL ?? '');
	if (!teamId || !channelId) {
		throw new Error('Pass --team and --channel, or set COPILOT_TEAMS_BRIDGE_TEAM and COPILOT_TEAMS_BRIDGE_CHANNEL.');
	}
	return new AgencyTeamsTransport({
		teamId,
		channelId,
		command: str(flags, 'agency', process.env.COPILOT_TEAMS_BRIDGE_AGENCY ?? 'agency'),
		logger: consoleLogger()
	});
}

function makeBridge(flags: Flags): Bridge {
	return new Bridge({
		transport: makeTransport(flags),
		store: new JsonSessionStore(path.join(HOME, 'sessions.json')),
		pollIntervalMs: Number(str(flags, 'interval', '5')) * 1000,
		workspace: str(flags, 'workspace', path.basename(process.cwd())),
		logger: consoleLogger()
	});
}

function printReply(routed: RoutedReply): void {
	console.log('');
	console.log('  ============== REPLY RECEIVED FROM TEAMS ==============');
	console.log(`  session : ${routed.session.title}   (key: ${routed.session.key})`);
	console.log(`  from    : ${routed.reply.from}   at ${routed.reply.createdAt}`);
	if (routed.command) {
		console.log(`  command : /${routed.command}`);
	}
	console.log('  text    :');
	for (const line of routed.text.split('\n')) {
		console.log(`      ${line}`);
	}
	console.log('  ======================================================');
	console.log('');
}

async function main(): Promise<void> {
	const { command, flags } = parseArgs(process.argv.slice(2));

	switch (command) {
		case 'notify': {
			const bridge = makeBridge(flags);
			const result = await bridge.notify({
				sessionKey: str(flags, 'key', 'demo'),
				title: str(flags, 'title', 'Copilot update'),
				summary: str(flags, 'summary', 'Work finished.'),
				status: str(flags, 'status', 'completed') as NotificationStatus,
				question: flags.question ? str(flags, 'question') : undefined,
				files: flags.files ? str(flags, 'files').split(',') : undefined,
				awaitingReply: Boolean(flags.wait)
			});
			console.log(`  Posted to Teams. session=${result.session.id} thread=${result.session.thread?.id}`);

			if (flags.wait) {
				const timeoutMs = Number(str(flags, 'timeout', '900')) * 1000;
				console.log(`  Waiting up to ${Math.round(timeoutMs / 1000)}s for your reply in Teams...`);
				const routed = await bridge.waitForReply(result.session.id, timeoutMs);
				if (routed) {
					printReply(routed);
				} else {
					console.log('  No reply within the timeout.');
					process.exitCode = 2;
				}
			}
			bridge.dispose();
			return;
		}

		case 'listen': {
			const bridge = makeBridge(flags);
			bridge.onReply(printReply);
			bridge.start();
			console.log(`  Listening for Teams replies across ${bridge.listSessions().length} session(s). Ctrl+C to stop.`);
			await new Promise(() => undefined);
			return;
		}

		case 'sessions': {
			const bridge = makeBridge(flags);
			const sessions = bridge.listSessions();
			if (sessions.length === 0) {
				console.log('  No sessions yet.');
			}
			for (const session of sessions) {
				console.log(`  ${session.closed ? '[closed]' : '[open]  '} ${session.key.padEnd(24)} ${session.title}`);
				console.log(`           thread=${session.thread?.id ?? '(none)'}`);
			}
			bridge.dispose();
			return;
		}

		case 'doctor': {
			// Verifies the pieces a working setup needs, so a misconfiguration is obvious.
			let failures = 0;
			const check = (label: string, ok: boolean, detail: string): void => {
				console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${label}`);
				if (detail) {
					console.log(`         ${detail}`);
				}
				if (!ok) {
					failures++;
				}
			};

			console.log('');
			console.log('  Copilot Teams Bridge - setup check');
			console.log('  ----------------------------------');

			const teamId = str(flags, 'team', process.env.COPILOT_TEAMS_BRIDGE_TEAM ?? '');
			const channelId = str(flags, 'channel', process.env.COPILOT_TEAMS_BRIDGE_CHANNEL ?? '');
			check('Team and channel configured', Boolean(teamId && channelId), teamId ? `team=${teamId.slice(0, 8)}… channel=${channelId.slice(0, 24)}…` : 'pass --team and --channel');

			if (teamId && channelId) {
				const transport = makeTransport(flags);
				try {
					const posted = await transport.createThread({
						sessionId: `doctor-${Date.now()}`,
						title: 'Teams Bridge self-check',
						summary: 'Posted by the doctor command to confirm the bridge can reach this channel.',
						status: 'progress'
					});
					check('Can post to the channel', true, `message id ${posted.thread.id}`);

					const replies = await transport.fetchReplies(posted.thread, undefined);
					check('Can read replies', true, `${replies.length} repl(y/ies) in the new thread`);
				} catch (error) {
					check('Can reach Teams', false, error instanceof Error ? error.message : String(error));
				}
				transport.dispose?.();
			}

			const sessions = new JsonSessionStore(path.join(HOME, 'sessions.json')).read();
			check('Session registry', true, `${sessions.length} session(s) recorded`);

			console.log('');
			console.log(failures === 0 ? '  All checks passed.' : `  ${failures} check(s) need attention.`);
			if (failures > 0) {
				process.exitCode = 1;
			}
			return;
		}

		default:
			console.log('Copilot Teams Bridge CLI');
			console.log('');
			console.log('  doctor   [--team <id>] [--channel <id>]        verify the setup end to end');
			console.log('  notify   --title <t> --summary <s> [--status completed|needs-input|failed|progress]');
			console.log('           [--key <k>] [--question <q>] [--files a,b] [--wait] [--timeout 900]');
			console.log('  listen   [--interval 5]                        stream replies as they arrive');
			console.log('  sessions                                       list known sessions');
			console.log('');
			console.log('  Teams target comes from --team/--channel or COPILOT_TEAMS_BRIDGE_TEAM/CHANNEL.');
			console.log('  Add --transport file --dir <path> to run offline against local files.');
	}
}

main().catch((error) => {
	console.error(`  ERROR: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
