import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import chalk from 'chalk';
import prompts from 'prompts';
import type { LLMProvider, Message } from '../providers/types.js';
import type { Tool } from '../tools/types.js';
import { AgentRunner } from './AgentRunner.js';
import type { BudgetGuard } from '../billing/BudgetGuard.js';

export type ComplexityLevel = 'low' | 'medium' | 'high';

export interface PlanStep {
  stepNumber: number;
  description: string;
  affectedFiles: string[];
  estimatedComplexity: ComplexityLevel;
}

export interface Plan {
  steps: PlanStep[];
  createdAt: string;
  userRequest: string;
}

export interface PlanExecutionContext {
  provider: LLMProvider;
  tools: Tool[];
  model: string;
  systemPrompt: string;
  history: Message[];
  budgetGuard?: BudgetGuard;
  projectRoot: string | null;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, input: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, result: string, isError: boolean) => void;
}

export class PlanMode {
  /**
   * Generate a step-by-step plan from user request
   */
  static async generatePlan(
    userRequest: string,
    ctx: PlanExecutionContext
  ): Promise<Plan | null> {
    console.log(chalk.dim('\n🔍 Generating plan...\n'));

    const planningPrompt = `You are a meticulous planning assistant. The user wants to accomplish the following:

"${userRequest}"

Create a detailed step-by-step plan to accomplish this task. Return ONLY a valid JSON object (no markdown, no explanations) with this exact structure:

{
  "steps": [
    {
      "stepNumber": 1,
      "description": "Brief description of what this step does",
      "affectedFiles": ["path/to/file1.ts", "path/to/file2.ts"],
      "estimatedComplexity": "low"
    }
  ]
}

Rules:
- Each step should be actionable and specific
- affectedFiles should list all files that will be read or modified (can be empty array if no files)
- estimatedComplexity must be one of: "low", "medium", "high"
- Order steps logically (dependencies first)
- Be thorough but concise

Return ONLY the JSON object, nothing else.`;

    try {
      const runner = new AgentRunner({
        userMessage: planningPrompt,
        systemPrompt: ctx.systemPrompt,
        provider: ctx.provider,
        model: ctx.model,
        tools: [], // No tools during planning — just text generation
        maxIterations: 1,
        history: ctx.history,
        budgetGuard: ctx.budgetGuard,
      });

      const result = await runner.run();
      const responseText = result.finalResponse.trim();

      // Extract JSON from response (handle markdown code blocks if present)
      let jsonText = responseText;
      const codeBlockMatch = responseText.match(/```(?:json)?\n?([\s\S]+?)\n?```/);
      if (codeBlockMatch) {
        jsonText = codeBlockMatch[1].trim();
      }

      const parsed = JSON.parse(jsonText);

      if (!parsed.steps || !Array.isArray(parsed.steps)) {
        throw new Error('Invalid plan format: missing steps array');
      }

      // Validate each step
      for (const step of parsed.steps) {
        if (
          typeof step.stepNumber !== 'number' ||
          typeof step.description !== 'string' ||
          !Array.isArray(step.affectedFiles) ||
          !['low', 'medium', 'high'].includes(step.estimatedComplexity)
        ) {
          throw new Error('Invalid step format');
        }
      }

      return {
        steps: parsed.steps,
        createdAt: new Date().toISOString(),
        userRequest,
      };
    } catch (err) {
      console.log(chalk.red(`\n✗ Failed to generate plan: ${(err as Error).message}`));
      return null;
    }
  }

  /**
   * Display the plan with formatting
   */
  static displayPlan(plan: Plan): void {
    console.log(chalk.bold('\n📋 Plan:\n'));

    for (const step of plan.steps) {
      const complexityColor =
        step.estimatedComplexity === 'high'
          ? chalk.red
          : step.estimatedComplexity === 'medium'
            ? chalk.yellow
            : chalk.green;

      console.log(
        `${chalk.cyan.bold(`Step ${step.stepNumber}:`)} ${step.description}`
      );

      if (step.affectedFiles.length > 0) {
        console.log(
          chalk.dim(`  Files: ${step.affectedFiles.join(', ')}`)
        );
      }

      console.log(
        `  Complexity: ${complexityColor(step.estimatedComplexity)}`
      );
      console.log();
    }
  }

  /**
   * Get user approval for the plan
   * @returns 'approved' | 'rejected' | 'edit'
   */
  static async getUserApproval(plan: Plan, projectRoot: string | null): Promise<'approved' | 'rejected' | 'edit'> {
    const response = await prompts({
      type: 'select',
      name: 'action',
      message: 'Approve plan?',
      choices: [
        { title: 'Yes — proceed with execution', value: 'approved' },
        { title: 'No — cancel', value: 'rejected' },
        { title: 'Edit — open in $EDITOR', value: 'edit' },
      ],
      initial: 0,
    });

    if (!response.action) {
      return 'rejected'; // User cancelled
    }

    if (response.action === 'edit') {
      // Save to temp file and open in editor
      const tempFile = path.join(
        projectRoot ?? '/tmp',
        `.epam-plan-${Date.now()}.json`
      );

      await fs.writeFile(tempFile, JSON.stringify(plan, null, 2), 'utf-8');

      const editor = process.env.EDITOR || process.env.VISUAL || 'vim';
      console.log(chalk.dim(`\nOpening ${tempFile} in ${editor}...\n`));

      try {
        // Spawn editor with inherited stdio for interactive editing
        await new Promise<void>((resolve, reject) => {
          const editorProcess = spawn(editor, [tempFile], {
            stdio: 'inherit',
          });

          editorProcess.on('exit', code => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Editor exited with code ${code}`));
            }
          });

          editorProcess.on('error', reject);
        });

        // Re-load the edited plan
        const edited = await fs.readFile(tempFile, 'utf-8');
        const editedPlan = JSON.parse(edited) as Plan;

        // Update the plan in-place
        plan.steps = editedPlan.steps;

        // Show updated plan
        console.log(chalk.green('\n✓ Plan updated from editor\n'));
        PlanMode.displayPlan(plan);

        // Clean up temp file
        await fs.unlink(tempFile).catch(() => {});

        // Ask again after edit
        return PlanMode.getUserApproval(plan, projectRoot);
      } catch (err) {
        console.log(chalk.red(`\n✗ Edit failed: ${(err as Error).message}`));
        return 'rejected';
      }
    }

    return response.action as 'approved' | 'rejected';
  }

  /**
   * Save the approved plan to .epam/plans/
   */
  static async savePlan(plan: Plan, projectRoot: string | null): Promise<string> {
    const plansDir = path.join(projectRoot ?? process.cwd(), '.epam', 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `plan-${timestamp}.json`;
    const filepath = path.join(plansDir, filename);

    await fs.writeFile(filepath, JSON.stringify(plan, null, 2), 'utf-8');

    return filepath;
  }

  /**
   * Execute the plan step-by-step
   */
  static async executePlan(plan: Plan, ctx: PlanExecutionContext): Promise<void> {
    console.log(chalk.bold.green('\n🚀 Executing plan...\n'));

    for (const step of plan.steps) {
      console.log(
        chalk.bold.cyan(`\n━━━ Step ${step.stepNumber}/${plan.steps.length}: ${step.description} ━━━\n`)
      );

      try {
        const runner = new AgentRunner({
          userMessage: `Execute this step from the plan:\n\n${step.description}\n\nAffected files: ${step.affectedFiles.join(', ') || 'none'}`,
          systemPrompt: ctx.systemPrompt,
          provider: ctx.provider,
          model: ctx.model,
          tools: ctx.tools,
          maxIterations: 20,
          history: ctx.history,
          budgetGuard: ctx.budgetGuard,
          onTextDelta: ctx.onTextDelta,
          onToolCall: ctx.onToolCall,
          onToolResult: ctx.onToolResult,
        });

        const result = await runner.run();

        // Update history with this step's messages
        ctx.history = result.messages;

        console.log(chalk.green(`\n✓ Step ${step.stepNumber} completed\n`));
      } catch (err) {
        console.log(
          chalk.red(`\n✗ Step ${step.stepNumber} failed: ${(err as Error).message}\n`)
        );

        // Pause and ask user what to do
        const action = await PlanMode.handleStepFailure(step, err as Error);

        if (action === 'retry') {
          // Retry the same step (decrement loop counter)
          plan.steps.splice(step.stepNumber - 1, 0, step);
          continue;
        } else if (action === 'skip') {
          console.log(chalk.yellow(`Skipping step ${step.stepNumber}\n`));
          continue;
        } else {
          // abort
          console.log(chalk.red('\n✗ Plan execution aborted\n'));
          break;
        }
      }
    }

    console.log(chalk.bold.green('\n✓ Plan execution complete!\n'));
  }

  /**
   * Handle step failure — prompt user for retry/skip/abort
   */
  private static async handleStepFailure(
    step: PlanStep,
    error: Error
  ): Promise<'retry' | 'skip' | 'abort'> {
    console.log(chalk.yellow(`\n⚠  Step ${step.stepNumber} encountered an error:`));
    console.log(chalk.dim(error.message));
    console.log();

    const response = await prompts({
      type: 'select',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { title: 'Retry this step', value: 'retry' },
        { title: 'Skip this step', value: 'skip' },
        { title: 'Abort plan execution', value: 'abort' },
      ],
      initial: 0,
    });

    return response.action || 'abort';
  }
}
