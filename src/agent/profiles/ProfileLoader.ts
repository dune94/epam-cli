import type { AgentRunOptions } from '../types.js';
import type { Profile, ProfileWithSource } from './types.js';
import type { Tool } from '../../tools/types.js';
import type { Decision } from '../../decisions/types.js';
import { DecisionStore } from '../../decisions/DecisionStore.js';
import { ProfileStore } from './ProfileStore.js';

export interface ConsultationResolution {
  profile: ProfileWithSource;
  decisions: Decision[];
}

/**
 * ProfileLoader merges profile settings into AgentRunOptions.
 */
export class ProfileLoader {
  static normalizeProfileName(name: string): string {
    return name.trim().replace(/^@/, '');
  }

  static async resolveConsultationProfile(
    profileName: string,
    projectRoot: string | null = null
  ): Promise<ProfileWithSource | null> {
    const normalizedName = this.normalizeProfileName(profileName);
    if (!normalizedName) {
      return null;
    }

    const store = new ProfileStore(projectRoot);
    return store.load(normalizedName);
  }

  static async listAvailableProfiles(projectRoot: string | null = null): Promise<ProfileWithSource[]> {
    const store = new ProfileStore(projectRoot);
    return store.list();
  }

  static async loadConsultationDecisions(
    projectRoot: string | null,
    profile: Pick<Profile, 'tags'>
  ): Promise<Decision[]> {
    if (!projectRoot || !profile.tags || profile.tags.length === 0) {
      return [];
    }

    try {
      const store = new DecisionStore(projectRoot);
      const matchingTags = new Set(profile.tags.map(tag => tag.toLowerCase()));
      const decisions = await store.list();

      return decisions
        .filter(decision =>
          decision.tags.some(tag => matchingTags.has(tag.toLowerCase()))
        )
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 3);
    } catch {
      return [];
    }
  }

  static async resolveConsultation(
    profileName: string,
    projectRoot: string | null = null
  ): Promise<ConsultationResolution | null> {
    const profile = await this.resolveConsultationProfile(profileName, projectRoot);
    if (!profile) {
      return null;
    }

    const decisions = await this.loadConsultationDecisions(projectRoot, profile);
    return { profile, decisions };
  }

  /**
   * Merge a profile into the base agent run options.
   *
   * Merging rules:
   * - systemPromptAppend: appended to existing systemPrompt with double newline
   * - tools: enabled/disabled overrides are applied to the tool list
   * - model: overrides the model if set
   * - maxIterations: overrides maxIterations if set
   *
   * @param baseOptions - The base agent run options to merge into
   * @param profile - The profile to apply
   * @returns New AgentRunOptions with profile settings merged
   */
  static merge(baseOptions: AgentRunOptions, profile: Profile): AgentRunOptions {
    const merged: AgentRunOptions = { ...baseOptions };

    // Append system prompt
    if (profile.systemPromptAppend) {
      merged.systemPrompt = baseOptions.systemPrompt
        ? `${baseOptions.systemPrompt}\n\n${profile.systemPromptAppend}`
        : profile.systemPromptAppend;
    }

    // Apply tool overrides
    if (profile.tools) {
      merged.tools = this.applyToolOverrides(
        baseOptions.tools,
        profile.tools.enabled ?? [],
        profile.tools.disabled ?? []
      );
    }

    // Override model
    if (profile.model) {
      merged.model = profile.model;
    }

    // Override maxIterations
    if (profile.maxIterations !== undefined) {
      merged.maxIterations = profile.maxIterations;
    }

    return merged;
  }

  /**
   * Apply tool enable/disable overrides to a tool list.
   */
  private static applyToolOverrides(
    tools: Tool[],
    enabled: string[],
    disabled: string[]
  ): Tool[] {
    // Build a set of all tool names from the original list
    const allTools = new Map(tools.map(t => [t.name, t]));

    // If enabled list is provided, start with only those tools
    if (enabled.length > 0) {
      const enabledSet = new Set(enabled);
      return tools.filter(t => enabledSet.has(t.name));
    }

    // If disabled list is provided, filter out those tools
    if (disabled.length > 0) {
      const disabledSet = new Set(disabled);
      return tools.filter(t => !disabledSet.has(t.name));
    }

    // No overrides, return original
    return tools;
  }

  /**
   * Create a profile from current agent run options.
   * Used by the "profile save" command to capture current session state.
   */
  static createFromOptions(
    name: string,
    description: string,
    options: AgentRunOptions,
    tags: string[] = []
  ): Profile {
    return {
      name,
      description,
      model: options.model,
      maxIterations: options.maxIterations,
      tools: {
        enabled: options.tools.map(t => t.name),
      },
      tags,
      // Note: systemPromptAppend is not captured from options since we don't
      // know which part was the base vs. appended. User would need to manually
      // set this when creating a profile.
    };
  }
}
