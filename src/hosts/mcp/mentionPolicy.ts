import type { MentionPolicy } from '../../domain/messageFormat';

/**
 * Reads the mention policy from an env-var value, falling back to the safe default.
 *
 * Lives in its own file because the stdio entry point runs `main()` on import, so a test
 * cannot exercise this mapping without also spawning the whole MCP server. An unset value
 * and an unrecognised value both map to `keyMoments`, matching the extension's default
 * and preventing a stray env var from silently downgrading the setting.
 */
export function mentionPolicyFromEnv(value: string | undefined): MentionPolicy {
	if (value === 'keyMoments' || value === 'everyMessage' || value === 'never') {
		return value;
	}
	return 'keyMoments';
}
