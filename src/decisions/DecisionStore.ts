import path from 'path';
import { appendLine, readLines, ensureDir } from '../utils/fs.js';
import type { Decision } from './types.js';

export class DecisionStore {
  private decisionsPath: string;

  constructor(projectRoot: string) {
    this.decisionsPath = path.join(projectRoot, '.epam', 'decisions.jsonl');
  }

  /**
   * Add a new decision record with auto-generated ID
   */
  async add(decision: Omit<Decision, 'id' | 'createdAt'>): Promise<Decision> {
    const existingDecisions = await this.list();
    const nextId = this.generateNextId(existingDecisions);

    const newDecision: Decision = {
      ...decision,
      id: nextId,
      createdAt: new Date().toISOString(),
    };

    await ensureDir(path.dirname(this.decisionsPath));
    await appendLine(this.decisionsPath, newDecision);

    return newDecision;
  }

  /**
   * List all decisions
   */
  async list(): Promise<Decision[]> {
    const lines = await readLines(this.decisionsPath);
    return lines
      .map(line => {
        try {
          return JSON.parse(line) as Decision;
        } catch {
          return null;
        }
      })
      .filter((d): d is Decision => d !== null);
  }

  /**
   * Search decisions by keyword (case-insensitive match on title, description, tags)
   */
  async search(query: string): Promise<Decision[]> {
    const allDecisions = await this.list();
    const lowerQuery = query.toLowerCase();

    return allDecisions.filter(decision => {
      const titleMatch = decision.title.toLowerCase().includes(lowerQuery);
      const descriptionMatch = decision.description?.toLowerCase().includes(lowerQuery) ?? false;
      const tagsMatch = decision.tags.some(tag => tag.toLowerCase().includes(lowerQuery));

      return titleMatch || descriptionMatch || tagsMatch;
    });
  }

  /**
   * Generate next sequential ID (DEC-001, DEC-002, etc.)
   */
  private generateNextId(existingDecisions: Decision[]): string {
    if (existingDecisions.length === 0) {
      return 'DEC-001';
    }

    // Extract numeric part from IDs and find max
    const numbers = existingDecisions
      .map(d => {
        const match = d.id.match(/^DEC-(\d+)$/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter(n => n > 0);

    const maxNumber = Math.max(0, ...numbers);
    const nextNumber = maxNumber + 1;

    return `DEC-${String(nextNumber).padStart(3, '0')}`;
  }
}
