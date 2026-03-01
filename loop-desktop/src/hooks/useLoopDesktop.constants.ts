import type { ComposerModel, ThinkingLevel } from '../types/ui';

export const STORAGE_KEY = 'loop-desktop-settings-v3';
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];
export const THINKING_LEVELS_BY_MODEL: Readonly<Record<ComposerModel, readonly ThinkingLevel[]>> = {
  // As of 2026-03-01 validation:
  // - gemini-3-pro-preview rejects minimal + medium
  // - gemini-3-flash-preview accepts all four
  // - gemini-3.1-pro-preview rejects minimal
  'gemini-3.1-pro-preview': ['low', 'medium', 'high'],
  'gemini-3-flash-preview': ['minimal', 'low', 'medium', 'high'],
  'gemini-3-pro-preview': ['low', 'high'],
};
export const DEFAULT_COMPOSER_MODEL: ComposerModel = 'gemini-3.1-pro-preview';
export const COMPOSER_MODELS: readonly ComposerModel[] = [
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
];
export const TERMINAL_TURN_KINDS = new Set(['turn_complete', 'turn_aborted', 'error']);
export const COMMAND_APPROVAL_KINDS = new Set(['approval_request']);
