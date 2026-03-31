import type { LLMProvider } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';
import { AgentRunner } from '../AgentRunner.js';
import {
  LEADER_ROLE,
  CODER_ROLE,
  TESTER_ROLE,
  SECURITY_AUDITOR_ROLE,
  filterToolsForRole,
} from './roles.js';
import { TaskRegistry } from '../TaskRegistry.js';

export interface SquadSubtask {
  id: string;
  role: 'Coder' | 'Tester' | 'SecurityAuditor';
  description: string;
  dependsOn: string[];
}

export interface SquadPlan {
  subtasks: SquadSubtask[];
}

export interface SecurityReview {
  status: 'approved' | 'blocked';
  findings: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low';
    issue: string;
    location: string;
    recommendation: string;
  }>;
  summary: string;
}

export interface SquadRunOptions {
  taskDescription: string;
  provider: LLMProvider;
  model: string;
  tools: Tool[];
  dangerousSkipApproval: boolean;
  maxOutputTokens?: number;
  onProgress?: (role: string, message: string) => void;
}

export interface SquadResult {
  plan: SquadPlan;
  coderOutput?: string;
  testerOutput?: string;
  securityReview?: SecurityReview;
  finalOutput: string;
  reviewCycles: number;
}

const MAX_REVIEW_CYCLES = 2;

export class SquadRunner {
  constructor(private options: SquadRunOptions) {}

  async run(): Promise<SquadResult> {
    // Phase 1: Leader decomposes the task
    this.options.onProgress?.('Leader', 'Decomposing task...');
    const plan = await this.runLeader();

    // Phase 2: Run agents according to plan
    const results = new Map<string, string>();
    let coderOutput = '';
    let testerOutput = '';

    // Run Coder and Tester in parallel
    const coderTask = plan.subtasks.find(t => t.role === 'Coder');
    const testerTask = plan.subtasks.find(t => t.role === 'Tester');
    const auditorTask = plan.subtasks.find(t => t.role === 'SecurityAuditor');

    const parallelTasks: Promise<void>[] = [];

    if (coderTask) {
      const taskId = TaskRegistry.register(`Squad: ${CODER_ROLE.name} - ${coderTask.description.slice(0, 60)}...`);
      parallelTasks.push(
        this.runAgent(CODER_ROLE, coderTask.description)
          .then(output => {
            coderOutput = output;
            results.set(coderTask.id, output);
            TaskRegistry.markDone(taskId, 'Coder completed');
          })
          .catch(err => {
            TaskRegistry.markFailed(taskId, (err as Error).message);
            throw err;
          })
      );
    }

    if (testerTask) {
      const taskId = TaskRegistry.register(`Squad: ${TESTER_ROLE.name} - ${testerTask.description.slice(0, 60)}...`);
      parallelTasks.push(
        this.runAgent(TESTER_ROLE, testerTask.description)
          .then(output => {
            testerOutput = output;
            results.set(testerTask.id, output);
            TaskRegistry.markDone(taskId, 'Tester completed');
          })
          .catch(err => {
            TaskRegistry.markFailed(taskId, (err as Error).message);
            throw err;
          })
      );
    }

    await Promise.all(parallelTasks);

    // Phase 3: Security review cycle (if Auditor task exists)
    let securityReview: SecurityReview | undefined;
    let reviewCycles = 0;

    if (auditorTask && coderOutput) {
      const reviewResult = await this.runReviewCycle(
        coderOutput,
        auditorTask.description
      );
      securityReview = reviewResult.review;
      reviewCycles = reviewResult.cycles;
      if (reviewResult.finalCoderOutput) {
        coderOutput = reviewResult.finalCoderOutput;
      }
    }

    // Phase 4: Assemble final output
    const finalOutput = this.assembleFinalOutput(
      coderOutput,
      testerOutput,
      securityReview
    );

    return {
      plan,
      coderOutput,
      testerOutput,
      securityReview,
      finalOutput,
      reviewCycles,
    };
  }

  private async runLeader(): Promise<SquadPlan> {
    const runner = new AgentRunner({
      userMessage: this.options.taskDescription,
      systemPrompt: LEADER_ROLE.systemPrompt,
      provider: this.options.provider,
      model: this.options.model,
      tools: [],
      maxIterations: 3,
      dangerousSkipApproval: true,
      maxOutputTokens: this.options.maxOutputTokens,
    });

    const result = await runner.run();
    return this.parseSquadPlan(result.finalResponse);
  }

  private parseSquadPlan(response: string): SquadPlan {
    // Extract JSON from response (may be wrapped in markdown or have extra text)
    const jsonMatch = response.match(/\{[\s\S]*"subtasks"[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Leader failed to produce valid SquadPlan JSON');
    }

    try {
      const plan = JSON.parse(jsonMatch[0]) as SquadPlan;
      if (!plan.subtasks || !Array.isArray(plan.subtasks)) {
        throw new Error('Invalid SquadPlan: missing subtasks array');
      }
      return plan;
    } catch (err) {
      throw new Error(`Failed to parse SquadPlan: ${(err as Error).message}`);
    }
  }

  private async runAgent(
    role: typeof CODER_ROLE | typeof TESTER_ROLE | typeof SECURITY_AUDITOR_ROLE,
    taskDescription: string
  ): Promise<string> {
    this.options.onProgress?.(role.name, 'Working...');

    const tools = filterToolsForRole(role, this.options.tools);
    const runner = new AgentRunner({
      userMessage: taskDescription,
      systemPrompt: role.systemPrompt,
      provider: this.options.provider,
      model: this.options.model,
      tools,
      maxIterations: 20,
      dangerousSkipApproval: this.options.dangerousSkipApproval,
      maxOutputTokens: this.options.maxOutputTokens,
    });

    const result = await runner.run();
    this.options.onProgress?.(role.name, 'Complete');
    return result.finalResponse;
  }

  private async runReviewCycle(
    initialCoderOutput: string,
    auditorTaskDescription: string
  ): Promise<{
    review: SecurityReview;
    cycles: number;
    finalCoderOutput?: string;
  }> {
    let currentCoderOutput = initialCoderOutput;
    let cycles = 0;

    for (let i = 0; i < MAX_REVIEW_CYCLES; i++) {
      cycles++;
      this.options.onProgress?.('SecurityAuditor', 'Reviewing...');

      const taskId = TaskRegistry.register(`Squad: ${SECURITY_AUDITOR_ROLE.name} - Review cycle ${cycles}`);

      const reviewContext = `${auditorTaskDescription}\n\nCode to review:\n${currentCoderOutput}`;
      const reviewOutput = await this.runAgent(
        SECURITY_AUDITOR_ROLE,
        reviewContext
      );

      const review = this.parseSecurityReview(reviewOutput);

      if (review.status === 'approved') {
        TaskRegistry.markDone(taskId, `Security review approved (cycle ${cycles})`);
        return { review, cycles, finalCoderOutput: currentCoderOutput };
      }

      TaskRegistry.markDone(taskId, `Security review blocked (${review.findings.length} findings)`);

      // Blocked - send findings back to Coder
      if (i < MAX_REVIEW_CYCLES - 1) {
        this.options.onProgress?.(
          'SecurityAuditor',
          `Blocked (${review.findings.length} findings) - returning to Coder`
        );

        const reworkTaskId = TaskRegistry.register(`Squad: ${CODER_ROLE.name} - Rework after review cycle ${cycles}`);
        const reworkTask = this.buildReworkTask(currentCoderOutput, review);
        try {
          currentCoderOutput = await this.runAgent(CODER_ROLE, reworkTask);
          TaskRegistry.markDone(reworkTaskId, 'Coder rework completed');
        } catch (err) {
          TaskRegistry.markFailed(reworkTaskId, (err as Error).message);
          throw err;
        }
      } else {
        // Max cycles reached - return blocked review
        this.options.onProgress?.(
          'SecurityAuditor',
          'Max review cycles reached - review blocked'
        );
        return { review, cycles };
      }
    }

    throw new Error('Review cycle exceeded maximum iterations');
  }

  private parseSecurityReview(output: string): SecurityReview {
    const jsonMatch = output.match(/\{[\s\S]*"status"[\s\S]*\}/);
    if (!jsonMatch) {
      // If Auditor didn't produce JSON, assume approval with no findings
      return {
        status: 'approved',
        findings: [],
        summary: 'No security issues found',
      };
    }

    try {
      const review = JSON.parse(jsonMatch[0]) as SecurityReview;
      if (!review.status || !['approved', 'blocked'].includes(review.status)) {
        throw new Error('Invalid status');
      }
      return review;
    } catch (err) {
      throw new Error(`Failed to parse SecurityReview: ${(err as Error).message}`);
    }
  }

  private buildReworkTask(originalOutput: string, review: SecurityReview): string {
    const findingsList = review.findings
      .map(
        (f, i) =>
          `${i + 1}. [${f.severity.toUpperCase()}] ${f.issue}\n   Location: ${f.location}\n   Fix: ${f.recommendation}`
      )
      .join('\n\n');

    return `Security review identified issues that must be fixed:

${findingsList}

Original implementation:
${originalOutput}

Please address all findings and provide the corrected implementation.`;
  }

  private assembleFinalOutput(
    coderOutput: string,
    testerOutput: string,
    securityReview?: SecurityReview
  ): string {
    const sections: string[] = [];

    if (coderOutput) {
      sections.push('## Implementation\n\n' + coderOutput);
    }

    if (testerOutput) {
      sections.push('## Testing Analysis\n\n' + testerOutput);
    }

    if (securityReview) {
      if (securityReview.status === 'approved') {
        sections.push(
          `## Security Review\n\n✓ Approved - ${securityReview.summary}`
        );
      } else {
        const findingsSummary = securityReview.findings
          .map(f => `- [${f.severity}] ${f.issue}`)
          .join('\n');
        sections.push(
          `## Security Review\n\n✗ Blocked - ${securityReview.summary}\n\nFindings:\n${findingsSummary}`
        );
      }
    }

    return sections.join('\n\n');
  }
}
