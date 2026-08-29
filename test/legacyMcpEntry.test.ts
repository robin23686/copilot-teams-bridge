import * as assert from 'assert';
import { describe, it } from 'node:test';
import { findBridgeServerNames, stripJsonComments } from '../src/hosts/vscode/legacyMcpEntry';

/**
 * A leftover manual entry is worse than a duplicate: both copies share one sessions.json,
 * so whichever reads a reply first marks it seen and the other never delivers it.
 */
describe('legacy mcp.json detection', () => {
	it('finds the entry whatever the user named it', () => {
		const text = JSON.stringify({
			servers: {
				'my-teams-thing': { command: 'node', args: ['C:\\code\\copilot-teams-bridge\\out\\src\\mcp\\stdio.js'] }
			}
		});

		assert.deepStrictEqual(findBridgeServerNames(text), ['my-teams-thing']);
	});

	it('matches posix paths too', () => {
		const text = JSON.stringify({
			servers: { bridge: { command: 'node', args: ['/home/u/copilot-teams-bridge/out/src/mcp/stdio.js'] } }
		});

		assert.deepStrictEqual(findBridgeServerNames(text), ['bridge']);
	});

	it('leaves unrelated servers alone', () => {
		const text = JSON.stringify({
			servers: {
				github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
				other: { command: 'node', args: ['C:\\tools\\some\\stdio.js'] }
			}
		});

		assert.deepStrictEqual(findBridgeServerNames(text), []);
	});

	it('reads the file even though VS Code allows comments in it', () => {
		const text = `{
			// the bridge, added by hand during setup
			"servers": {
				"copilot-teams-bridge": {
					/* runs from a working copy */
					"command": "node",
					"args": ["C:\\\\code\\\\copilot-teams-bridge\\\\out\\\\src\\\\mcp\\\\stdio.js"]
				}
			}
		}`;

		assert.deepStrictEqual(findBridgeServerNames(text), ['copilot-teams-bridge']);
	});

	it('keeps comment markers that are inside strings', () => {
		const text = '{"servers":{"a":{"command":"http://example.com/*x*/"}}}';

		assert.strictEqual(stripJsonComments(text), text);
	});

	it('says nothing when the file is malformed rather than guessing', () => {
		assert.deepStrictEqual(findBridgeServerNames('{ not json'), []);
		assert.deepStrictEqual(findBridgeServerNames(''), []);
		assert.deepStrictEqual(findBridgeServerNames('{"servers": null}'), []);
	});
});
