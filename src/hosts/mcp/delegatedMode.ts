/**
 * Reads the delegated-mode flag from an env-var value, falling back to off.
 *
 * A delegated agent MCP session is a short-lived process spawned by a parent agent. It
 * has no long-lived thread to watch, so opening a Teams conversation from it would create
 * a dead letterbox: a reply posted there is collected only while the process is still
 * running, and never once it exits. A delegated agent should instead report its result
 * to the agent that spawned it, and that parent — which is long-lived and owns a real
 * thread — decides what reaches Teams.
 *
 * Lives in its own file, mirroring {@link mentionPolicyFromEnv} and {@link harnessFromEnv},
 * so a test can exercise the mapping without spawning the whole MCP server (stdio's
 * `main()` runs on import). Unset and unrecognised both map to `false` — the safe
 * direction, matching every existing install where no delegated flag was ever emitted.
 *
 * `1`, `true` and `yes` are accepted case-insensitively and after trimming, so the
 * launcher can emit any of the shell-idiomatic on-values without the mapping quibbling.
 */
export function delegatedFromEnv(value: string | undefined): boolean {
	if (value === undefined) {
		return false;
	}
	const normalised = value.trim().toLowerCase();
	return normalised === '1' || normalised === 'true' || normalised === 'yes';
}

/**
 * Starts the bridge's Teams-polling loop unless this server is delegated.
 *
 * A delegated server has no thread of its own to watch, so it must do no Teams I/O at
 * all — starting the loop would issue reads against a channel the process has no
 * business reading. Kept as a tiny helper so the wire-up in {@link stdio.ts} can be
 * covered by a test without spawning the whole MCP server (stdio's `main()` runs on
 * import). Duck-typed on `start` so the helper stays in the mcp host without pulling in
 * the concrete Bridge from application, which the layer check would reject.
 */
export function startBridgeUnlessDelegated(bridge: { start(): void }, delegated: boolean): void {
	if (delegated) {
		return;
	}
	bridge.start();
}
