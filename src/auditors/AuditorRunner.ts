import type { LLMProvider, Message } from '../providers/types.js';
import type { Tool } from '../tools/types.js';
import type {
  AuditorConfig,
  AuditorFinding,
  AuditorGateDecision,
  AuditorInput,
  AuditorResult,
  SeverityLevel,
} from './types.js';
import { SEVERITY_RANK } from './types.js';
import { AgentRunner } from '../agent/AgentRunner.js';
import { logger } from '../utils/logger.js';

/**
 * Executes a single persona-specific auditor against a proposed agent response.
 */
export class AuditorRunner {
  readonly name: string;

  constructor(
    readonly config: AuditorConfig,
    private provider: LLMProvider,
    private tools: Tool[],
  ) {
    this.name = config.name;
  }

  async run(input: AuditorInput): Promise<AuditorResult> {
    try {
      const runner = new AgentRunner({
        userMessage: this.buildAuditorUserPrompt(input),
        systemPrompt: this.buildAuditorSystemPrompt(),
        provider: this.provider,
        model: this.config.model,
        tools: this.tools,
        maxIterations: 5,
        dangerousSkipApproval: true,
      });

      const result = await runner.run();
      const findings = this.parseFindings(result.finalResponse);

      return {
        auditorName: this.config.name,
        findings,
        transcript: result.finalResponse,
        severity: this.getMaxSeverity(findings),
      };
    } catch (error) {
      logger.error({ error, auditor: this.config.name }, 'Auditor execution failed');
      return {
        auditorName: this.config.name,
        findings: [],
        transcript: `[ERROR] Auditor failed to execute: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'info',
      };
    }
  }

  exceedsThreshold(result: AuditorResult): boolean {
    return (
      result.findings.length > 0 &&
      SEVERITY_RANK[result.severity] >= SEVERITY_RANK[this.config.severity_threshold]
    );
  }

  static evaluateGate(results: AuditorResult[], runners: AuditorRunner[]): AuditorGateDecision {
    const runnerByName = new Map(runners.map(runner => [runner.name, runner]));
    const blockingAuditors = results.filter(result => runnerByName.get(result.auditorName)?.exceedsThreshold(result));

    return {
      blocked: blockingAuditors.length > 0,
      blockingAuditors,
    };
  }

  private buildAuditorSystemPrompt(): string {
    return [
      `You are ${this.config.name}.`,
      `Persona: ${this.config.persona}`,
      `Primary focus: ${this.config.focus}`,
      '',
      'Audit the assistant response for issues that matter to your persona and focus area.',
      'You are reviewing a candidate answer before it is shown to the user.',
      'Consider correctness, safety, omissions, weak assumptions, and conflicts with the conversation context.',
      '',
      'Output one finding per line using exactly this format:',
      '[SEVERITY: info|warning|critical] <finding>',
      '',
      'If there are no issues, return:',
      '[SEVERITY: info] No findings.',
      '',
      'Be concise, concrete, and avoid generic advice.',
    ].join('\n');
  }

  private buildAuditorUserPrompt(input: AuditorInput): string {
    return [
      'Review this interaction before the answer is confirmed.',
      '',
      'User message:',
      input.userMessage,
      '',
      'Proposed assistant response:',
      input.proposedResponse,
      '',
      'Full conversation context:',
      this.formatConversationHistory(input.conversationHistory),
    ].join('\n');
  }

  private formatConversationHistory(history: Message[]): string {
    if (history.length === 0) {
      return '[no prior context]';
    }

    return history
      .map(message => {
        const role = message.role.toUpperCase();
        const content =
          typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content);
        return `${role}: ${content}`;
      })
      .join('\n\n');
  }

  private parseFindings(transcript: string): AuditorFinding[] {
    const findings: AuditorFinding[] = [];

    for (const line of transcript.split('\n')) {
      const match = line.match(/\[SEVERITY:\s*(info|warning|critical)\]\s*(.+)/i);
      if (!match) {
        continue;
      }

      const finding = match[2].trim();
      if (finding.toLowerCase() === 'no findings.') {
        continue;
      }

      findings.push({
        auditorName: this.config.name,
        severity: match[1].toLowerCase() as SeverityLevel,
        finding,
      });
    }

    return findings;
  }

  private getMaxSeverity(findings: AuditorFinding[]): SeverityLevel {
    if (findings.some(finding => finding.severity === 'critical')) {
      return 'critical';
    }

    if (findings.some(finding => finding.severity === 'warning')) {
      return 'warning';
    }

    return 'info';
  }
}
