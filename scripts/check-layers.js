#!/usr/bin/env node
/**
 * Fails the build when an import crosses a layer boundary the wrong way.
 *
 * A layering that is only written down is a layering that erodes: every rule in this
 * codebase that lived in the wrong place caused a bug, and none of them announced
 * themselves. Dependencies point inward only, so the domain can be reasoned about without
 * the editor, and a use case without a live Teams connection.
 *
 * Kept deliberately simple — one regex per file, no AST — so it is obvious what it checks.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

/** What each layer is allowed to depend on. Anything else is an error. */
const ALLOWED = {
	domain: [],
	application: ['domain'],
	infrastructure: ['domain', 'application'],
	hosts: ['domain', 'application', 'infrastructure']
};

/** Only the outermost layer may talk to the editor. */
const VSCODE_LAYER = 'hosts';

function layerOf(file) {
	return path.relative(SRC, file).split(path.sep)[0];
}

function walk(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
	});
}

const violations = [];

for (const file of walk(SRC)) {
	const layer = layerOf(file);
	const allowed = ALLOWED[layer];
	if (!allowed) {
		violations.push(`${path.relative(SRC, file)}: not inside a known layer`);
		continue;
	}

	const source = fs.readFileSync(file, 'utf8');
	const imports = [...source.matchAll(/from\s+'([^']+)'|require\('([^']+)'\)/g)].map(
		(match) => match[1] ?? match[2]
	);

	for (const specifier of imports) {
		if (specifier === 'vscode' && layer !== VSCODE_LAYER) {
			violations.push(
				`${path.relative(SRC, file)}: imports 'vscode' from the ${layer} layer — ` +
					`only ${VSCODE_LAYER} may touch the editor API`
			);
			continue;
		}
		if (!specifier.startsWith('.')) {
			continue; // A package, not one of ours.
		}
		const target = layerOf(path.resolve(path.dirname(file), specifier));
		if (target === layer || !ALLOWED[target]) {
			continue; // Same layer, or not resolvable to one.
		}
		if (!allowed.includes(target)) {
			violations.push(
				`${path.relative(SRC, file)}: ${layer} imports from ${target} — ` +
					`dependencies point inward only (${layer} may use: ${allowed.join(', ') || 'nothing'})`
			);
		}
	}
}

if (violations.length > 0) {
	console.error(`Layer violations (${violations.length}):\n`);
	for (const violation of violations) {
		console.error(`  ${violation}`);
	}
	process.exit(1);
}

console.log('Layers clean: dependencies point inward only.');
