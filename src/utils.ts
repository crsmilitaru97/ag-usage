import { spawn } from 'child_process';
import { MAX_PID_32BIT_SIGNED, MAX_PORT, MIN_PORT } from './constants';

export const MAX_BUFFER_SIZE = 1024 * 1024;

export function validatePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= MAX_PID_32BIT_SIGNED;
}

export function validatePort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

const COMMAND_TIMEOUT_MS = 10000;

export function executeCommand(command: string, args: string[], timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (data: Buffer) => {
      if (stdout.length + data.length > MAX_BUFFER_SIZE) {
        clearTimeout(timeout);
        proc.kill();
        reject(new Error(`Command output exceeded ${MAX_BUFFER_SIZE} bytes`));
        return;
      }
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      if (stderr.length + data.length > MAX_BUFFER_SIZE) {
        return;
      }
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) { return; }
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Command exited with code ${code}`));
      }
    });
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
