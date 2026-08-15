import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export function protectPrivateFile(target) {
  chmodSync(target, 0o600);
  if (process.platform !== "win32") return target;
  // Removing inheritance is not sufficient: /grant:r only replaces ACEs for
  // the named identity and leaves any explicit Users/Everyone/other-SID grant
  // in place. Build an exact ACL instead, before private content is written.
  const script = [
    "$target = $env:CODEX_ROUTER_PRIVATE_FILE",
    "$isDirectory = [System.IO.Directory]::Exists($target)",
    "$acl = if ($isDirectory) { [System.IO.Directory]::GetAccessControl($target) } else { [System.IO.File]::GetAccessControl($target) }",
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$rules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))",
    "foreach ($rule in $rules) { [void]$acl.RemoveAccessRuleSpecific($rule) }",
    "$inheritance = if ($isDirectory) { [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [Security.AccessControl.InheritanceFlags]::None }",
    "$ownerRule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)",
    "[void]$acl.AddAccessRule($ownerRule)",
    "$acl.SetOwner($sid)",
    "if ($isDirectory) { [System.IO.Directory]::SetAccessControl($target, $acl) } else { [System.IO.File]::SetAccessControl($target, $acl) }",
  ].join("; ");
  execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, CODEX_ROUTER_PRIVATE_FILE: target },
      stdio: "ignore",
    },
  );
  return target;
}

// All private JSON state uses the same temp-file, owner-only, atomic replace.
// Keeping it here prevents one state writer from drifting away from the rest.
export function writePrivateFile(target, contents, { directoryMode } = {}) {
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (directoryMode !== undefined) chmodSync(directory, directoryMode);
  const temporary = `${target}.tmp.${process.pid}`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    protectPrivateFile(temporary);
    renameSync(temporary, target);
    protectPrivateFile(target);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return target;
}

export function writePrivateJson(target, value, { space = 2, directoryMode } = {}) {
  writePrivateFile(target, `${JSON.stringify(value, null, space)}\n`, { directoryMode });
  return value;
}

export function privateFileIsProtected(target) {
  if (!existsSync(target)) return false;
  if (process.platform !== "win32") return (statSync(target).mode & 0o777) === 0o600;
  const script = [
    // Get-Acl lazy-loads Microsoft.PowerShell.Security, which can fail under
    // concurrent Windows processes. The .NET API returns the same FileSecurity
    // object without importing a PowerShell module.
    "$target = $env:CODEX_ROUTER_PRIVATE_FILE",
    "$isDirectory = [System.IO.Directory]::Exists($target)",
    "$acl = if ($isDirectory) { [System.IO.Directory]::GetAccessControl($target) } else { [System.IO.File]::GetAccessControl($target) }",
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])",
    "$rules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))",
    "$exact = $acl.AreAccessRulesProtected -and $owner -eq $sid -and $rules.Count -eq 1",
    "$expectedInheritance = if ($isDirectory) { [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [Security.AccessControl.InheritanceFlags]::None }",
    "if ($exact) { $rule = $rules[0]; $exact = $rule.IdentityReference -eq $sid -and $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and -not $rule.IsInherited -and $rule.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and $rule.InheritanceFlags -eq $expectedInheritance -and $rule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None }",
    "[Console]::Out.Write($exact.ToString())",
  ].join("; ");
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_ROUTER_PRIVATE_FILE: target },
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}
