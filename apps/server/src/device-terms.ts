import type { DevicePlatform } from '@cc-desk-tunnel/protocol';

// What Claude is told that depends on the system of the device: in the system prompt, and again with a
// message when a session goes on from a device of another system. Everything else reads the same for all,
// and is worded to hold on every system: what becomes of a process when its command ends differs between
// them, so Claude is told to count on neither outcome.
export function deviceTerms(platform: DevicePlatform, projectPath: string) {
  if (platform === 'win32')
    return {
      name: 'Windows',
      script: `On Windows it is PowerShell 7, as plain text: any length, UTF-8, nothing to escape or encode. Errors come back as plain text and the script's exit code is kept; standard input is the script, so it cannot read more. Begin it with Set-Location -LiteralPath '${projectPath.replaceAll("'", "''")}'.`,
      command: `The host device runs a command line as it is, parsed by cmd.exe on Windows, and is the one for scp or sftp, where a Windows path takes forward slashes: the project directory is ${JSON.stringify(`device:${projectPath.replaceAll('\\', '/')}`)}.`,
    };
  const name = platform === 'darwin' ? 'macOS' : 'Linux';
  return {
    name,
    script: `On ${name} it is the user's own shell, zsh or bash, with the environment of their terminal, as plain text: any length, UTF-8, nothing to escape or encode. The script's exit code is kept; standard input is the script, so it cannot read more. Begin it with cd -- '${projectPath.replaceAll("'", "'\\''")}'.`,
    command: `The host device runs a command line as it is, parsed by that same shell, and is the one for scp or sftp: the project directory is ${JSON.stringify(`device:${projectPath}`)}.`,
  };
}
