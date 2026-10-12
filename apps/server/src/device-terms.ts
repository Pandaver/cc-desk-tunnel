import type { DevicePlatform } from '@cc-desk-tunnel/protocol';

// What Claude is told that depends on the system of the device: in the system prompt, and again with a
// message when a session goes on from a device of another system. Everything else reads the same for all.
export function deviceTerms(platform: DevicePlatform, projectPath: string) {
  if (platform === 'win32')
    return {
      name: 'Windows',
      script: `On Windows it is PowerShell 7, as plain text: any length, UTF-8, nothing to escape or encode. Errors come back as plain text and the script's exit code is kept; standard input is the script, so it cannot read more. Begin it with Set-Location -LiteralPath '${projectPath.replaceAll("'", "''")}'.`,
      command: `The host device runs a command line as it is, parsed by cmd.exe on Windows, and is the one for scp or sftp, where a Windows path takes forward slashes: the project directory is ${JSON.stringify(`device:${projectPath.replaceAll('\\', '/')}`)}.`,
      ending:
        'Ending an ssh command does not reliably end what it started on the device; stop that process on the device.',
    };
  const name = platform === 'darwin' ? 'macOS' : 'Linux';
  return {
    name,
    script: `On ${name} it is the user's own shell, zsh or bash, with the environment of their terminal, as plain text: any length, UTF-8, nothing to escape or encode. The script's exit code is kept; standard input is the script, so it cannot read more. Begin it with cd -- '${projectPath.replaceAll("'", "'\\''")}'.`,
    command: `The host device runs a command line as it is, parsed by that same shell, and is the one for scp or sftp: the project directory is ${JSON.stringify(`device:${projectPath}`)}.`,
    ending:
      'What an ssh command started on the device ends with it, background processes included: keep the command running for as long as the process is needed.',
  };
}
