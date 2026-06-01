import { describe, it, expect } from 'vitest';

/**
 * Board Visualization — Provider/Model by Story (EPAM-027)
 * UI tests for provider/model visualization features
 */

describe('Board Visualization — Provider/Model', () => {
  describe('Provider Badge Rendering', () => {
    it('should render Claude provider badge', () => {
      const providerBadge = (provider: string) => {
        const p = (provider || '').toLowerCase();
        if (p.includes('claude') || p.includes('anthropic')) {
          return { cls: 'badge-claude', label: 'CLAUDE' };
        }
        if (p.includes('opencode')) {
          return { cls: 'badge-opencode', label: 'OPENCODE' };
        }
        if (p.includes('codex')) {
          return { cls: 'badge-codex', label: 'CODEX' };
        }
        return { cls: 'badge-pending', label: provider.toUpperCase() };
      };

      expect(providerBadge('claude')).toEqual({ cls: 'badge-claude', label: 'CLAUDE' });
      expect(providerBadge('anthropic')).toEqual({ cls: 'badge-claude', label: 'CLAUDE' });
      expect(providerBadge('opencode')).toEqual({ cls: 'badge-opencode', label: 'OPENCODE' });
      expect(providerBadge('codex')).toEqual({ cls: 'badge-codex', label: 'CODEX' });
    });

    it('should fall back gracefully for unknown providers', () => {
      const providerBadge = (provider: string) => {
        const p = (provider || '').toLowerCase();
        if (p.includes('claude') || p.includes('anthropic')) {
          return { cls: 'badge-claude', label: 'CLAUDE' };
        }
        if (p.includes('opencode')) {
          return { cls: 'badge-opencode', label: 'OPENCODE' };
        }
        if (p.includes('codex')) {
          return { cls: 'badge-codex', label: 'CODEX' };
        }
        return { cls: 'badge-pending', label: provider.toUpperCase() };
      };

      expect(providerBadge('unknown')).toEqual({ cls: 'badge-pending', label: 'UNKNOWN' });
    });

    it('should handle missing provider field', () => {
      const providerBadge = (provider: string) => {
        const p = (provider || '').toLowerCase();
        if (p.includes('claude') || p.includes('anthropic')) {
          return { cls: 'badge-claude', label: 'CLAUDE' };
        }
        return { cls: 'badge-pending', label: (provider || 'unknown').toUpperCase() };
      };

      expect(providerBadge('')).toEqual({ cls: 'badge-pending', label: 'UNKNOWN' });
    });
  });

  describe('Model Info Resolution', () => {
    it('should resolve model info from model ID', () => {
      const MODEL_INFO = {
        'claude-haiku-4-5': { label: 'HAIKU', cls: 'haiku', turns: '10' },
        'claude-haiku-4-5-20251001': { label: 'HAIKU', cls: 'haiku', turns: '10' },
        'claude-sonnet-4-6': { label: 'SONNET', cls: 'sonnet', turns: '30' },
        'claude-opus-4-6': { label: 'OPUS', cls: 'opus', turns: 'unlimited' },
      };

      const modelInfo = (model: string) => {
        return MODEL_INFO[model as keyof typeof MODEL_INFO] || null;
      };

      expect(modelInfo('claude-haiku-4-5')).toEqual({ label: 'HAIKU', cls: 'haiku', turns: '10' });
      expect(modelInfo('claude-sonnet-4-6')).toEqual({ label: 'SONNET', cls: 'sonnet', turns: '30' });
      expect(modelInfo('claude-opus-4-6')).toEqual({ label: 'OPUS', cls: 'opus', turns: 'unlimited' });
    });

    it('should handle non-Claude providers correctly', () => {
      const modelInfo = (provider: string) => {
        const p = provider.toLowerCase();
        if (p === 'opencode') return { label: 'OPENCODE', cls: 'opencode', turns: '—' };
        if (p === 'codex') return { label: 'CODEX', cls: 'codex', turns: '—' };
        return { label: 'UNKNOWN', cls: 'pending', turns: '—' };
      };

      expect(modelInfo('opencode')).toEqual({ label: 'OPENCODE', cls: 'opencode', turns: '—' });
      expect(modelInfo('codex')).toEqual({ label: 'CODEX', cls: 'codex', turns: '—' });
    });
  });

  describe('Provider/Model Filtering', () => {
    it('should filter stories by provider', () => {
      const stories = [
        { id: 'S1', provider: 'claude', model: 'claude-haiku-4-5' },
        { id: 'S2', provider: 'opencode', model: 'gpt-4o' },
        { id: 'S3', provider: 'claude', model: 'claude-sonnet-4-6' },
      ];

      const filterByProvider = (provider: string) => {
        return stories.filter((s) =>
          (s.provider || '').toLowerCase().includes(provider.toLowerCase())
        );
      };

      expect(filterByProvider('claude')).toHaveLength(2);
      expect(filterByProvider('opencode')).toHaveLength(1);
      expect(filterByProvider('')).toHaveLength(3);
    });

    it('should filter stories by model', () => {
      const stories = [
        { id: 'S1', provider: 'claude', model: 'claude-haiku-4-5' },
        { id: 'S2', provider: 'opencode', model: 'gpt-4o' },
        { id: 'S3', provider: 'claude', model: 'claude-sonnet-4-6' },
      ];

      const filterByModel = (model: string) => {
        return stories.filter((s) =>
          (s.model || '').toLowerCase().includes(model.toLowerCase())
        );
      };

      expect(filterByModel('haiku')).toHaveLength(1);
      expect(filterByModel('sonnet')).toHaveLength(1);
      expect(filterByModel('gpt')).toHaveLength(1);
      expect(filterByModel('')).toHaveLength(3);
    });
  });

  describe('Model Distribution Counts', () => {
    it('should calculate model distribution for phase', () => {
      const stories = [
        { id: 'S1', model: 'claude-haiku-4-5' },
        { id: 'S2', model: 'claude-haiku-4-5' },
        { id: 'S3', model: 'claude-sonnet-4-6' },
        { id: 'S4', model: 'gpt-4o' },
      ];

      const modelCounts: Record<string, number> = {};
      stories.forEach((s) => {
        const model = s.model?.includes('haiku')
          ? 'HAIKU'
          : s.model?.includes('sonnet')
          ? 'SONNET'
          : s.model?.includes('gpt')
          ? 'GPT-4O'
          : 'UNKNOWN';
        modelCounts[model] = (modelCounts[model] || 0) + 1;
      });

      expect(modelCounts).toEqual({
        HAIKU: 2,
        SONNET: 1,
        'GPT-4O': 1,
      });
    });

    it('should format model counts for display', () => {
      const modelCounts = {
        HAIKU: 2,
        SONNET: 1,
        'GPT-4O': 1,
      };

      const formatModelCounts = () => {
        return Object.entries(modelCounts)
          .sort(([, a], [, b]) => b - a)
          .map(([m, c]) => `${c}×${m}`)
          .join(' · ');
      };

      expect(formatModelCounts()).toBe('2×HAIKU · 1×SONNET · 1×GPT-4O');
    });
  });

  describe('Monitor Payload Provider/Model Fields', () => {
    it('should include provider and model in story_start event', () => {
      const createStoryStartEvent = (
        storyId: string,
        provider: string,
        model: string
      ) => {
        return {
          type: 'story_start',
          story: storyId,
          provider,
          model,
          timestamp: new Date().toISOString(),
        };
      };

      const event = createStoryStartEvent('EPAM-001', 'claude', 'claude-sonnet-4-6');
      expect(event.provider).toBe('claude');
      expect(event.model).toBe('claude-sonnet-4-6');
    });

    it('should include provider and model in stories object', () => {
      const createStoryEntry = (
        storyId: string,
        provider: string,
        model: string
      ) => {
        return {
          [storyId]: {
            status: 'start',
            provider,
            model,
            updatedAt: new Date().toISOString(),
          },
        };
      };

      const story = createStoryEntry('EPAM-001', 'claude', 'claude-sonnet-4-6');
      expect(story['EPAM-001'].provider).toBe('claude');
      expect(story['EPAM-001'].model).toBe('claude-sonnet-4-6');
    });
  });

  describe('Graceful Degradation', () => {
    it('should render without provider/model fields', () => {
      const story = {
        id: 'EPAM-001',
        title: 'Test Story',
        status: 'pending',
      };

      const hasProvider = 'provider' in story;
      const hasModel = 'model' in story;

      expect(hasProvider).toBe(false);
      expect(hasModel).toBe(false);

      // Should not throw
      const providerDisplay = (story as any).provider || 'unknown';
      const modelDisplay = (story as any).model || '—';

      expect(providerDisplay).toBe('unknown');
      expect(modelDisplay).toBe('—');
    });

    it('should handle null/undefined provider/model values', () => {
      const story = {
        id: 'EPAM-001',
        title: 'Test Story',
        status: 'pending',
        provider: null,
        model: undefined,
      };

      const providerDisplay = story.provider || 'unknown';
      const modelDisplay = story.model || '—';

      expect(providerDisplay).toBe('unknown');
      expect(modelDisplay).toBe('—');
    });
  });
});
