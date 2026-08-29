/**
 * Minimal JSON-RPC 2.0 framing over stdio, as used by the Model Context Protocol.
 *
 * Implemented directly rather than pulling in the MCP SDK so the server stays dependency
 * free and testable with plain streams.
 */

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: string | number | null;
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export const JSON_RPC_ERRORS = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603
} as const;

/**
 * Parses a stream of newline-delimited JSON-RPC messages.
 *
 * MCP stdio servers use line framing; a partial line is buffered until its newline
 * arrives, so a message split across chunks is handled correctly.
 */
export class LineProtocol {
	private buffer = '';

	constructor(
		private readonly onMessage: (message: JsonRpcRequest) => void,
		private readonly onError?: (error: Error) => void
	) {}

	push(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf('\n');
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) {
				try {
					this.onMessage(JSON.parse(line) as JsonRpcRequest);
				} catch (error) {
					this.onError?.(error instanceof Error ? error : new Error(String(error)));
				}
			}
			newline = this.buffer.indexOf('\n');
		}
	}
}

export function serialise(response: JsonRpcResponse): string {
	return `${JSON.stringify(response)}\n`;
}

export function success(id: string | number | null, result: unknown): JsonRpcResponse {
	return { jsonrpc: '2.0', id, result };
}

export function failure(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
	return { jsonrpc: '2.0', id, error: { code, message, data } };
}
