import * as path from 'path';
import * as vscode from 'vscode';
import type { MentionPolicy } from '../../domain/messageFormat';

export type TransportKind = 'agency' | 'file';
export type ReplyDelivery = 'guarded' | 'always' | 'never';
export type UnroutableReplies = 'hold' | 'focusedChat';
export type ReplyTargeting = 'editorGroup' | 'sidebarOnly';
/** How much of a conversation reaches Teams. */
export type TurnUpdates = 'everyTurn' | 'milestonesOnly';

export interface BridgeConfig {
	transport: TransportKind;
	agencyCommand: string;
	teamId: string;
	channelId: string;
	fileDirectory: string;
	pollIntervalMs: number;
	waitForReplyTimeoutMs: number;
	autoSubmitReplies: boolean;
	replyDelivery: ReplyDelivery;
	unroutableReplies: UnroutableReplies;
	replyTargeting: ReplyTargeting;
	/**
	 * How long the target chat's transcript must be silent — no new bytes, no `mtime`
	 * change, no file arriving at all — before an unfound marker is treated as unproven.
	 * Not a hard cap on confirmation: activity in the file resets it, so a chat that is
	 * still writing keeps being waited for up to an absolute ceiling.
	 */
	deliveryConfirmMs: number;
	announceSessions: boolean;
	announceMinPromptLength: number;
	/**
	 * Whether Teams hears about every finished turn, or only the milestones the model
	 * chooses to report — start, blocked, finished.
	 */
	turnUpdates: TurnUpdates;
	/** How much of an answer a turn summary may carry. */
	turnSummaryChars: number;
	acknowledgeReplies: boolean;
	relayAgentReplies: boolean;
	expiredGraceMs: number;
	autoStart: boolean;
	sessionIdleMs: number;
	/** When to @mention the user in Teams. See {@link MentionPolicy}. */
	mentionPolicy: MentionPolicy;
}

export const CONFIG_SECTION = 'copilotTeamsBridge';

export function readConfig(context: vscode.ExtensionContext): BridgeConfig {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const fallbackDirectory = path.join(context.globalStorageUri.fsPath, 'file-transport');

	return {
		transport: config.get<TransportKind>('transport', 'agency'),
		agencyCommand: text(config.get<string>('agency.command', '')) || 'agency',
		teamId: text(config.get<string>('teamId', '')),
		channelId: text(config.get<string>('channelId', '')),
		fileDirectory: text(config.get<string>('file.directory', '')) || fallbackDirectory,
		pollIntervalMs: clamp(config.get<number>('pollIntervalSeconds', 10), 3, 300) * 1000,
		waitForReplyTimeoutMs: clamp(config.get<number>('waitForReplyTimeoutSeconds', 7200), 30, 7200) * 1000,
		autoSubmitReplies: config.get<boolean>('autoSubmitReplies', true),
		replyDelivery: config.get<ReplyDelivery>('replyDelivery', 'guarded'),
		unroutableReplies: config.get<UnroutableReplies>('unroutableReplies', 'hold'),
		replyTargeting: config.get<ReplyTargeting>('replyTargeting', 'editorGroup'),
		deliveryConfirmMs: clamp(config.get<number>('deliveryConfirmSeconds', 30), 1, 300) * 1000,
		announceSessions: config.get<boolean>('announceSessions', true),
		announceMinPromptLength: Math.max(0, config.get<number>('announceMinPromptLength', 30)),
		turnUpdates: config.get<TurnUpdates>('turnUpdates', 'everyTurn'),
		turnSummaryChars: clamp(config.get<number>('turnSummaryCharacters', 600), 120, 4000),
		acknowledgeReplies: config.get<boolean>('acknowledgeReplies', true),
		relayAgentReplies: config.get<boolean>('relayAgentReplies', true),
		expiredGraceMs: Math.max(0, config.get<number>('expiredGraceHours', 0)) * 60 * 60 * 1000,
		autoStart: config.get<boolean>('autoStart', true),
		sessionIdleMs: Math.max(1, config.get<number>('sessionIdleMinutes', 120)) * 60 * 1000,
		mentionPolicy: config.get<MentionPolicy>('mentionOn', 'keyMoments')
	};
}

export function currentWorkspaceName(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	return folder ? folder.name : vscode.workspace.name;
}

function text(value: string | undefined): string {
	return (value ?? '').trim();
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.min(max, Math.max(min, value));
}



