import type { Tool } from './types.js';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * Register a tool with the given name.
   * @param name - The tool name (can be namespaced, e.g., "server/tool")
   * @param tool - The tool implementation
   */
  register(name: string, tool: Tool): void {
    this.tools.set(name, tool);
  }

  /**
   * Register multiple tools at once.
   */
  registerMany(tools: Tool[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Get a tool by name.
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools.
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get all tools matching a namespace prefix (e.g., "server/*")
   */
  getByNamespace(namespace: string): Tool[] {
    const prefix = namespace.endsWith('/') ? namespace : `${namespace}/`;
    return Array.from(this.tools.values()).filter(tool =>
      tool.name.startsWith(prefix)
    );
  }

  /**
   * Check if a tool exists.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Remove a tool.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Clear all registered tools.
   */
  clear(): void {
    this.tools.clear();
  }

  /**
   * Get the count of registered tools.
   */
  get size(): number {
    return this.tools.size;
  }
}
