import { describe, it, expect } from 'vitest';
import {
  classifyTool,
  requiresApproval,
  isDangerous,
} from '../../../src/tools/approval/SafetyPolicy.js';

describe('SafetyPolicy', () => {
  describe('classifyTool', () => {
    it('classifies bash as dangerous regardless of declared permission', () => {
      expect(classifyTool('bash', 'safe')).toBe('dangerous');
    });

    it('classifies write_file as review', () => {
      expect(classifyTool('write_file', 'safe')).toBe('review');
    });

    it('classifies read_file as safe regardless of declared permission', () => {
      expect(classifyTool('read_file', 'dangerous')).toBe('safe');
    });

    it('uses declared permission for unknown tools', () => {
      expect(classifyTool('my_custom_tool', 'review')).toBe('review');
      expect(classifyTool('my_custom_tool', 'safe')).toBe('safe');
    });
  });

  describe('isDangerous', () => {
    it('returns true for bash', () => {
      expect(isDangerous('bash', 'safe')).toBe(true);
    });

    it('returns false for read_file', () => {
      expect(isDangerous('read_file', 'safe')).toBe(false);
    });
  });

  describe('requiresApproval', () => {
    it('returns false when dangerousSkipApproval=true regardless of tool', () => {
      expect(requiresApproval('bash', 'dangerous', true)).toBe(false);
      expect(requiresApproval('write_file', 'review', true)).toBe(false);
    });

    it('requires approval for dangerous tools', () => {
      expect(requiresApproval('bash', 'dangerous', false)).toBe(true);
    });

    it('requires approval for review tools', () => {
      expect(requiresApproval('write_file', 'review', false)).toBe(true);
    });

    it('does not require approval for safe tools', () => {
      expect(requiresApproval('read_file', 'safe', false)).toBe(false);
    });
  });
});
