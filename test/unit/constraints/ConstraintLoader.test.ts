import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConstraintLoader } from '../../../src/constraints/ConstraintLoader.js';
import type { BackendClient } from '../../../src/http/BackendClient.js';
import type { Constraint } from '../../../src/constraints/types.js';

describe('ConstraintLoader', () => {
  let mockBackendClient: BackendClient;
  let constraintLoader: ConstraintLoader;

  beforeEach(() => {
    mockBackendClient = {
      getProjectConstraints: vi.fn(),
    } as unknown as BackendClient;
    constraintLoader = new ConstraintLoader(mockBackendClient);
  });

  describe('loadConstraints', () => {
    it('should fetch and return active constraints', async () => {
      const mockResponse = {
        constraints: [
          {
            id: 'c1',
            rule: 'Never use eval()',
            severity: 'block',
            createdBy: 'admin',
            expiresAt: new Date(Date.now() + 86400000).toISOString(), // expires tomorrow
          },
          {
            id: 'c2',
            rule: 'Prefer const over let',
            severity: 'warn',
            createdBy: 'admin',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
        ],
      };

      vi.mocked(mockBackendClient.getProjectConstraints).mockResolvedValue(mockResponse);

      const result = await constraintLoader.loadConstraints('proj-123');

      expect(result).toHaveLength(2);
      expect(result[0].rule).toBe('Never use eval()');
      expect(result[1].rule).toBe('Prefer const over let');
      expect(mockBackendClient.getProjectConstraints).toHaveBeenCalledWith('proj-123');
    });

    it('should filter out expired constraints', async () => {
      const mockResponse = {
        constraints: [
          {
            id: 'c1',
            rule: 'Active constraint',
            severity: 'block',
            createdBy: 'admin',
            expiresAt: new Date(Date.now() + 86400000).toISOString(), // expires tomorrow
          },
          {
            id: 'c2',
            rule: 'Expired constraint',
            severity: 'warn',
            createdBy: 'admin',
            expiresAt: new Date(Date.now() - 86400000).toISOString(), // expired yesterday
          },
        ],
      };

      vi.mocked(mockBackendClient.getProjectConstraints).mockResolvedValue(mockResponse);

      const result = await constraintLoader.loadConstraints('proj-123');

      expect(result).toHaveLength(1);
      expect(result[0].rule).toBe('Active constraint');
    });

    it('should cache results for session duration', async () => {
      const mockResponse = {
        constraints: [
          {
            id: 'c1',
            rule: 'Cached constraint',
            severity: 'block',
            createdBy: 'admin',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
        ],
      };

      vi.mocked(mockBackendClient.getProjectConstraints).mockResolvedValue(mockResponse);

      // First call
      const result1 = await constraintLoader.loadConstraints('proj-123');
      expect(result1).toHaveLength(1);
      expect(mockBackendClient.getProjectConstraints).toHaveBeenCalledTimes(1);

      // Second call should use cache
      const result2 = await constraintLoader.loadConstraints('proj-123');
      expect(result2).toHaveLength(1);
      expect(mockBackendClient.getProjectConstraints).toHaveBeenCalledTimes(1); // Still only called once
    });

    it('should return empty array and log warning when endpoint is unreachable', async () => {
      vi.mocked(mockBackendClient.getProjectConstraints).mockRejectedValue(
        new Error('Network error')
      );

      const result = await constraintLoader.loadConstraints('proj-123');

      expect(result).toEqual([]);
    });

    it('should return empty array and log warning when response schema is invalid', async () => {
      const invalidResponse = {
        // missing 'constraints' array
        data: [],
      };

      vi.mocked(mockBackendClient.getProjectConstraints).mockResolvedValue(invalidResponse);

      const result = await constraintLoader.loadConstraints('proj-123');

      expect(result).toEqual([]);
    });

    it('should reject malformed constraint entries without crashing the session', async () => {
      vi.mocked(mockBackendClient.getProjectConstraints).mockResolvedValue({
        constraints: [
          {
            id: 'c1',
            rule: 'Bad severity',
            severity: 'critical',
            createdBy: 'admin',
            expiresAt: 'not-a-date',
          },
        ],
      });

      const result = await constraintLoader.loadConstraints('proj-123');

      expect(result).toEqual([]);
    });

    it('should cache constraints per project id', async () => {
      vi.mocked(mockBackendClient.getProjectConstraints)
        .mockResolvedValueOnce({
          constraints: [
            {
              id: 'c1',
              rule: 'Project one',
              severity: 'block',
              createdBy: 'admin',
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
            },
          ],
        })
        .mockResolvedValueOnce({
          constraints: [
            {
              id: 'c2',
              rule: 'Project two',
              severity: 'warn',
              createdBy: 'admin',
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
            },
          ],
        });

      const projectOne = await constraintLoader.loadConstraints('proj-1');
      const projectTwo = await constraintLoader.loadConstraints('proj-2');

      expect(projectOne[0].rule).toBe('Project one');
      expect(projectTwo[0].rule).toBe('Project two');
      expect(mockBackendClient.getProjectConstraints).toHaveBeenCalledTimes(2);
    });
  });

  describe('separateConstraintsBySeverity', () => {
    it('should separate constraints by severity', () => {
      const constraints: Constraint[] = [
        {
          id: 'c1',
          rule: 'Block rule 1',
          severity: 'block',
          createdBy: 'admin',
          expiresAt: '2026-12-31T23:59:59Z',
        },
        {
          id: 'c2',
          rule: 'Warn rule 1',
          severity: 'warn',
          createdBy: 'admin',
          expiresAt: '2026-12-31T23:59:59Z',
        },
        {
          id: 'c3',
          rule: 'Block rule 2',
          severity: 'block',
          createdBy: 'admin',
          expiresAt: '2026-12-31T23:59:59Z',
        },
      ];

      const result = constraintLoader.separateConstraintsBySeverity(constraints);

      expect(result.block).toHaveLength(2);
      expect(result.warn).toHaveLength(1);
      expect(result.block[0].rule).toBe('Block rule 1');
      expect(result.block[1].rule).toBe('Block rule 2');
      expect(result.warn[0].rule).toBe('Warn rule 1');
    });

    it('should handle empty constraint list', () => {
      const result = constraintLoader.separateConstraintsBySeverity([]);

      expect(result.block).toEqual([]);
      expect(result.warn).toEqual([]);
    });
  });
});
