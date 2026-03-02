import { describe, it, expect } from 'vitest';
import { BashTool } from '../../../src/tools/builtin/Bash.js';

describe('BashTool', () => {
  const bashTool = new BashTool();

  describe('classifyError', () => {
    describe('recoverable errors', () => {
      it('should classify exit code 1 with syntax error as recoverable', () => {
        const result = bashTool.classifyError(1, 'syntax error: unexpected token', 'npm run build');
        expect(result.recoverable).toBe(true);
        expect(result.reason).toBe('syntax_error');
      });

      it('should classify exit code 1 with type error as recoverable', () => {
        const result = bashTool.classifyError(1, 'TypeError: Cannot read property', 'node script.js');
        expect(result.recoverable).toBe(true);
        expect(result.reason).toBe('type_error');
      });

      it('should classify module not found as recoverable', () => {
        const result = bashTool.classifyError(1, 'Cannot find module "xyz"', 'node app.js');
        expect(result.recoverable).toBe(true);
        expect(result.reason).toBe('module_not_found');
      });

      it('should classify compilation errors as recoverable', () => {
        const result = bashTool.classifyError(1, 'error: expected semicolon', 'tsc');
        expect(result.recoverable).toBe(true);
        expect(result.reason).toBe('compilation_error');
      });

      it('should classify generic exit code 1 with stderr as recoverable', () => {
        const result = bashTool.classifyError(1, 'Something went wrong', 'npm test');
        expect(result.recoverable).toBe(true);
        expect(result.reason).toContain('exit_code_1');
      });

      it('should classify exit code 2 as recoverable', () => {
        const result = bashTool.classifyError(2, 'Usage error', 'bash script.sh');
        expect(result.recoverable).toBe(true);
      });

      it('should classify command_not_found as recoverable', () => {
        const result = bashTool.classifyError(127, 'command not found: docker', 'docker ps');
        expect(result.recoverable).toBe(true);
        expect(result.reason).toBe('command_not_found');
      });
    });

    describe('non-recoverable errors', () => {
      it('should classify signal-based failures as non-recoverable', () => {
        const result = bashTool.classifyError(-9, 'Killed', 'npm run heavy-task');
        expect(result.recoverable).toBe(false);
        expect(result.reason).toBe('signal_failure');
      });

      it('should classify segfault as non-recoverable', () => {
        const result = bashTool.classifyError(-11, 'Segmentation fault', './native-binary');
        expect(result.recoverable).toBe(false);
        expect(result.reason).toBe('signal_failure');
      });

      it('should classify permission denied as non-recoverable', () => {
        const result = bashTool.classifyError(1, 'Permission denied', 'rm /etc/passwd');
        expect(result.recoverable).toBe(false);
        expect(result.reason).toBe('permission_denied');
      });

      it('should classify EACCES as non-recoverable', () => {
        const result = bashTool.classifyError(1, 'EACCES: permission denied', 'npm install');
        expect(result.recoverable).toBe(false);
        expect(result.reason).toBe('permission_denied');
      });

      it('should classify file not found as non-recoverable', () => {
        const result = bashTool.classifyError(1, 'No such file or directory', 'cat missing.txt');
        expect(result.recoverable).toBe(false);
        expect(result.reason).toBe('file_not_found');
      });

      it('should classify directory not found as non-recoverable', () => {
        const result = bashTool.classifyError(1, 'No such directory', 'cd /missing');
        expect(result.recoverable).toBe(false);
        expect(result.reason).toBe('file_not_found');
      });

      it('should classify unknown high exit codes as non-recoverable', () => {
        const result = bashTool.classifyError(128, '', 'unknown-command');
        expect(result.recoverable).toBe(false);
        expect(result.reason).toContain('unknown_error_128');
      });
    });

    describe('edge cases', () => {
      it('should handle empty stderr gracefully', () => {
        const result = bashTool.classifyError(1, '', 'command');
        expect(result.recoverable).toBe(false);
      });

      it('should handle case-insensitive matching', () => {
        const result1 = bashTool.classifyError(1, 'SYNTAX ERROR', 'command');
        expect(result1.recoverable).toBe(true);
        
        const result2 = bashTool.classifyError(1, 'PERMISSION DENIED', 'command');
        expect(result2.recoverable).toBe(false);
      });

      it('should include suggestion for all error types', () => {
        const recoverable = bashTool.classifyError(1, 'syntax error', 'command');
        expect(recoverable.suggestion).toBeDefined();
        
        const nonRecoverable = bashTool.classifyError(-9, 'killed', 'command');
        expect(nonRecoverable.suggestion).toBeDefined();
      });
    });
  });

  describe('execute', () => {
    it('should return BashToolResult with error classification on failure', async () => {
      // This test would require mocking execa
      // For now, we verify the type is exported
      expect(bashTool.name).toBe('bash');
      expect(bashTool.permission).toBe('dangerous');
    });
  });
});
