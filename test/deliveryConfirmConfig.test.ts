import * as assert from 'assert';
import { describe, it, before } from 'node:test';

/**
 * The `deliveryConfirmSeconds` setting is the quiet window that ends adaptive delivery
 * confirmation, so its default and its bounds matter. The default was raised from 8 to
 * 30 seconds after live traces showed VS Code took ~8.3s to flush a request into a cold
 * chat's transcript — under an 8s deadline the reveal reported success and the bridge
 * still marked the reply as unverifiable. The clamp ceiling was widened from 60s to 300s
 * so a truly slow machine can still be tuned without editing the source.
 */

interface BridgeConfigShape {
	deliveryConfirmMs: number;
	[key: string]: unknown;
}

type ReadConfig = (context: { globalStorageUri: { fsPath: string } }) => BridgeConfigShape;

let readConfig: ReadConfig | undefined;
let getConfigurationCallback: ((section: string) => Record<string, unknown>) | undefined;

before(() => {
	/* eslint-disable @typescript-eslint/no-require-imports */
	const Module = require('module') as { _load(request: string, parent: unknown, isMain: boolean): unknown };
	const originalLoad = Module._load.bind(Module);
	Module._load = (request: string, parent: unknown, isMain: boolean): unknown =>
		request === 'vscode'
			? {
					workspace: {
						getConfiguration: (section: string): unknown => {
							const overrides = getConfigurationCallback?.(section) ?? {};
							return {
								get<T>(key: string, fallback: T): T {
									return (overrides[key] as T | undefined) ?? fallback;
								}
							};
						}
					}
				}
			: originalLoad(request, parent, isMain);
	const module = require('../src/hosts/vscode/config') as { readConfig: ReadConfig };
	/* eslint-enable @typescript-eslint/no-require-imports */
	Module._load = originalLoad;
	readConfig = module.readConfig;
});

function context(): { globalStorageUri: { fsPath: string } } {
	return { globalStorageUri: { fsPath: '/tmp/fake' } };
}

describe('readConfig: deliveryConfirmSeconds default and clamping', () => {
	it('defaults to 30 seconds when the setting is unset', () => {
		getConfigurationCallback = () => ({});
		const config = readConfig!(context());
		assert.strictEqual(config.deliveryConfirmMs, 30_000, 'default must be 30s to survive cold-chat flushes');
	});

	it('clamps values above 300 down to 300', () => {
		getConfigurationCallback = () => ({ deliveryConfirmSeconds: 900 });
		const config = readConfig!(context());
		assert.strictEqual(config.deliveryConfirmMs, 300_000, 'the ceiling for the setting is 300 seconds');
	});

	it('clamps values below 1 up to 1', () => {
		getConfigurationCallback = () => ({ deliveryConfirmSeconds: 0 });
		const config = readConfig!(context());
		assert.strictEqual(config.deliveryConfirmMs, 1_000, 'the floor for the setting is 1 second');
	});

	it('accepts values inside the widened range', () => {
		getConfigurationCallback = () => ({ deliveryConfirmSeconds: 120 });
		const config = readConfig!(context());
		assert.strictEqual(config.deliveryConfirmMs, 120_000);
	});
});
