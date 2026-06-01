import { Command } from 'commander';
import chalk from 'chalk';

interface ProxyHealthCheckResult {
  ok: boolean;
  backend_url_set: boolean;
  backend_url?: string;
  response_received: boolean;
  response_time_ms?: number;
  json_valid: boolean;
  required_fields_present: boolean;
  error?: string;
  result?: Record<string, unknown>;
}

async function invokeProxyBackend(backendUrl: string): Promise<{
  success: boolean;
  output: string;
  duration_ms: number;
  error?: string;
}> {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const prompt = 'echo hello';
    const response = await fetch(`${backendUrl}/v1/proxy/anthropic/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const duration = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        output: '',
        duration_ms: duration,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    const data = await response.json();
    const output = JSON.stringify(data);

    return { success: true, output, duration_ms: duration };
  } catch (err) {
    clearTimeout(timeoutId);
    const duration = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      duration_ms: duration,
      error: errorMsg,
    };
  }
}

function isValidJSON(jsonStr: string): boolean {
  try {
    JSON.parse(jsonStr);
    return true;
  } catch {
    return false;
  }
}

function hasRequiredFields(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return 'content' in obj && 'usage' in obj && 'stopReason' in obj;
}

async function performProxyHealthCheck(): Promise<ProxyHealthCheckResult> {
  const result: ProxyHealthCheckResult = {
    ok: false,
    backend_url_set: false,
    response_received: false,
    json_valid: false,
    required_fields_present: false,
  };

  // Step 1: Check backend URL
  const backendUrl = process.env.EPAM_BACKEND_URL;
  if (!backendUrl) {
    result.error = 'EPAM_BACKEND_URL environment variable not set';
    return result;
  }

  result.backend_url_set = true;
  result.backend_url = backendUrl;

  // Step 2: Invoke proxy backend
  const invocation = await invokeProxyBackend(backendUrl);
  if (!invocation.success) {
    result.error = `Failed to invoke proxy backend: ${invocation.error}`;
    return result;
  }

  result.response_received = true;
  result.response_time_ms = invocation.duration_ms;

  // Step 3: Validate JSON response
  if (!isValidJSON(invocation.output)) {
    result.error = 'Response is not valid JSON';
    return result;
  }

  result.json_valid = true;

  // Step 4: Validate required fields
  const parsedData = JSON.parse(invocation.output);
  if (!hasRequiredFields(parsedData)) {
    result.error = 'Response missing required fields (content, usage, stopReason)';
    return result;
  }

  result.required_fields_present = true;
  result.result = parsedData;
  result.ok = true;

  return result;
}

export function createHealthCheckProxyCommand(): Command {
  return new Command('health-check-proxy')
    .description('Health check: verify Claude CLI with proxy backend')
    .action(async () => {
      try {
        const check = await performProxyHealthCheck();

        console.log(chalk.bold('\nClaude CLI Proxy Health Check\n'));

        // Backend URL check
        const backendIcon = check.backend_url_set ? chalk.green('✓') : chalk.red('✗');
        const backendMsg = check.backend_url_set ? `Connected to ${check.backend_url}` : 'EPAM_BACKEND_URL not set';
        console.log(`${backendIcon} Backend URL: ${backendMsg}`);

        // Response check
        const responseIcon = check.response_received ? chalk.green('✓') : chalk.red('✗');
        const responseMsg = check.response_received
          ? `Received in ${check.response_time_ms}ms`
          : 'No response received';
        console.log(`${responseIcon} Response Received: ${responseMsg}`);

        // JSON validation
        const jsonIcon = check.json_valid ? chalk.green('✓') : chalk.red('✗');
        const jsonMsg = check.json_valid ? 'Valid JSON' : 'Invalid JSON format';
        console.log(`${jsonIcon} JSON Validation: ${jsonMsg}`);

        // Required fields check
        const fieldsIcon = check.required_fields_present ? chalk.green('✓') : chalk.red('✗');
        const fieldsMsg = check.required_fields_present
          ? 'Has content, usage, stopReason'
          : 'Missing required fields';
        console.log(`${fieldsIcon} Required Fields: ${fieldsMsg}`);

        if (check.result) {
          console.log(chalk.dim('\nResponse structure:'));
          console.log(JSON.stringify(check.result, null, 2));
        }

        console.log();

        if (check.ok) {
          console.log(chalk.green.bold('All checks passed!'));
          console.log(JSON.stringify(check, null, 2));
          process.exit(0);
        } else {
          console.log(chalk.red.bold('Health check failed!'));
          console.log(`Error: ${check.error}`);
          console.log(JSON.stringify(check, null, 2));
          process.exit(1);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`Health check error: ${error}`));
        process.exit(1);
      }
    });
}
