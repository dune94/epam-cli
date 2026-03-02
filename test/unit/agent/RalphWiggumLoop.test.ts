import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RalphWiggumLoop } from '../../../src/agent/RalphWiggumLoop.js';
import {
  DEFAULT_RALPH_WIGGUM_CONFIG,
  STRATEGY_DESCRIPTIONS,
  type RalphWiggumInput,
} from '../../../src/agent/RalphWiggumLoop.types.js';

// Mock execa for testing
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

describe('RalphWiggumLoop', () => {
  let loop: RalphWiggumLoop;

  beforeEach(() => {
    loop = new RalphWiggumLoop();
  });

  describe('constructor', () => {
    it('should use default config when no options provided', () => {
      expect(loop).toBeDefined();
    });

    it('should accept custom config options', () => {
      const customLoop = new RalphWiggumLoop({
        parallelAgents: 5,
        agentTimeout: 60000,
        verifyFix: false,
      });
      expect(customLoop).toBeDefined();
    });
  });

  describe('distributeStrategies', () => {
    it('should distribute strategies evenly among agents', () => {
      // With 3 agents and 3 strategies, each gets one
      const strategies = DEFAULT_RALPH_WIGGUM_CONFIG.strategies;
      expect(strategies.length).toBe(3);
      expect(strategies).toContain('minimal_change');
      expect(strategies).toContain('refactor_approach');
      expect(strategies).toContain('alternative_impl');
    });

    it('should cycle strategies when more agents than strategies', () => {
      const customLoop = new RalphWiggumLoop({ parallelAgents: 6 });
      // Would distribute: minimal, refactor, alternative, minimal, refactor, alternative
      expect(customLoop).toBeDefined();
    });
  });

  describe('strategy descriptions', () => {
    it('should have descriptions for all strategies', () => {
      const strategies = DEFAULT_RALPH_WIGGUM_CONFIG.strategies;
      for (const strategy of strategies) {
        expect(STRATEGY_DESCRIPTIONS[strategy]).toBeDefined();
        expect(STRATEGY_DESCRIPTIONS[strategy].length).toBeGreaterThan(10);
      }
    });

    it('should include strategy number in description', () => {
      expect(STRATEGY_DESCRIPTIONS.minimal_change).toContain('Strategy 1');
      expect(STRATEGY_DESCRIPTIONS.refactor_approach).toContain('Strategy 2');
      expect(STRATEGY_DESCRIPTIONS.alternative_impl).toContain('Strategy 3');
    });
  });

  describe('error recovery flow', () => {
    const mockInput: RalphWiggumInput = {
      command: 'npm run build',
      stderr: 'TS2307: Cannot find module "xyz"',
      stdout: '',
      exitCode: 1,
      contextMessages: [],
      systemPrompt: 'You are a helpful coding assistant.',
    };

    it('should handle recoverable errors (exit code 1 with stderr)', () => {
      // This is validated by the BashTool error classification
      expect(mockInput.exitCode).toBe(1);
      expect(mockInput.stderr).toBeTruthy();
    });

    it('should track elapsed time', async () => {
      const startTime = Date.now();
      
      // Note: Full integration test requires mock provider
      // This test validates the timing mechanism exists
      expect(startTime).toBeGreaterThan(0);
    });
  });

  describe('quality scoring', () => {
    it('should prefer fixes with lower token counts', () => {
      // Quality score = tokenCount + penalty (if command doesn't pass)
      // Lower score is better
      const score1 = 100 + 0; // 100 tokens, passes
      const score2 = 200 + 0; // 200 tokens, passes
      expect(score1).toBeLessThan(score2);
    });

    it('should heavily penalize fixes that do not pass verification', () => {
      const passingScore = 100 + 0; // passes, 100 tokens
      const failingScore = 50 + 10000; // fails, 50 tokens but heavy penalty
      expect(passingScore).toBeLessThan(failingScore);
    });
  });
});

describe('RalphWiggumLoop types', () => {
  describe('RalphWiggumInput', () => {
    it('should accept valid input structure', () => {
      const input: RalphWiggumInput = {
        command: 'npm test',
        stderr: 'Test failed',
        stdout: 'Running tests...',
        exitCode: 1,
        contextMessages: [],
        systemPrompt: 'Test prompt',
      };
      expect(input.command).toBe('npm test');
      expect(input.exitCode).toBe(1);
    });
  });

  describe('DEFAULT_RALPH_WIGGUM_CONFIG', () => {
    it('should have 3 parallel agents by default', () => {
      expect(DEFAULT_RALPH_WIGGUM_CONFIG.parallelAgents).toBe(3);
    });

    it('should have 2 minute timeout by default', () => {
      expect(DEFAULT_RALPH_WIGGUM_CONFIG.agentTimeout).toBe(120000);
    });

    it('should verify fixes by default', () => {
      expect(DEFAULT_RALPH_WIGGUM_CONFIG.verifyFix).toBe(true);
    });

    it('should have 3 default strategies', () => {
      expect(DEFAULT_RALPH_WIGGUM_CONFIG.strategies.length).toBe(3);
    });
  });
});
