/**
 * Removes compiled files in out/ whose TypeScript source no longer exists.
 *
 * Deleting out/ wholesale also works, but VS Code runs the MCP server straight from
 * out/src/hosts/mcp/stdio.js, so a full wipe kills a server the editor is actively using and
 * the bridge tools vanish mid-session. Pruning only orphans keeps that file in place
 * while still stopping deleted modules from being tested or packaged.
 */
const fs = require('node:fs');
const path = require('node:path');

const outDir = path.join(__dirname, '..', 'out');
if (!fs.existsSync(outDir)) {
	process.exit(0);
}

const removed = [];

function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(full);
			if (fs.readdirSync(full).length === 0) {
				fs.rmdirSync(full);
			}
			continue;
		}

		const match = /\.(js|d\.ts|js\.map|d\.ts\.map|tsbuildinfo)$/.exec(entry.name);
		if (!match) {
			continue;
		}

		const relative = path.relative(outDir, full);
		const source = path.join(__dirname, '..', relative.replace(/\.(js|d\.ts|js\.map|d\.ts\.map)$/, '.ts'));
		if (!fs.existsSync(source)) {
			fs.rmSync(full);
			removed.push(relative);
		}
	}
}

walk(outDir);

if (removed.length > 0) {
	console.log(`Pruned ${removed.length} orphaned build artefact(s):`);
	for (const file of removed) {
		console.log(`  ${file}`);
	}
}
