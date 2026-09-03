const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packages = [
	'@github/copilot-sdk',
	'vscode-jsonrpc',
	'zod'
];

for (const packageName of packages) {
	const source = path.join(root, 'node_modules', ...packageName.split('/'));
	const target = path.join(root, 'out', 'node_modules', ...packageName.split('/'));
	if (!fs.existsSync(source)) {
		throw new Error(`Cannot package ${packageName}: run npm install first.`);
	}
	fs.rmSync(target, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.cpSync(source, target, { recursive: true });
}

console.log(`Staged ${packages.length} Copilot SDK package(s) under out/node_modules.`);
