import type { ThinkingLevel } from '../types/ui';

export const STORAGE_KEY = 'loop-desktop-settings-v3';
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['low', 'medium', 'high'];
export const TERMINAL_TURN_KINDS = new Set(['turn_complete', 'turn_aborted', 'error']);
export const COMMAND_APPROVAL_KINDS = new Set(['approval_request']);
