import { createInterface } from "readline";
import { accessSync, constants } from "fs";
import path from "path";
import { spawnSync } from "child_process";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
});

rl.prompt();

const BUILTINS = new Set(["echo", "exit", "type", "pwd", "cd"]);

function findExecutableInPath(command: string): string | null {
  const dirs = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  for (const dir of dirs) {
    if (!dir) continue;
    const fullPath = path.join(dir, command);
    try {
      accessSync(fullPath, constants.F_OK | constants.X_OK);
      return fullPath;
    } catch {
      // File doesn't exist or isn't executable; keep searching.
    }
  }
  return null;
}

rl.on("line", (input: string) => {
  const trimmed = input.trim();
  if (!trimmed) {
    rl.prompt();
    return;
  }
  const [command, ...args] = trimmed.split(/\s+/);

  if (command === "exit") {
    rl.close();
    return;
  }

  if (command === "echo") {
    console.log(args.join(" "));
    rl.prompt();
    return;
  }

  if (command === "cd") {
    let target = args[0];
    if (target === "~") {
      target = process.env.HOME;
    }
    if (target) {
      try {
        process.chdir(target);
      } catch {
        console.log(`cd: ${args[0]}: No such file or directory`);
      }
    }
    rl.prompt();
    return;
  }

  if (command === "pwd") {
    console.log(process.cwd());
    rl.prompt();
    return;
  }

  if (command === "type") {
    const target = args[0];
    if (target && BUILTINS.has(target)) {
      console.log(`${target} is a shell builtin`);
    } else if (target) {
      const fullPath = findExecutableInPath(target);
      if (fullPath) {
        console.log(`${target} is ${fullPath}`);
      } else {
        console.log(`${target}: not found`);
      }
    }
    rl.prompt();
    return;
  }

  const fullPath = findExecutableInPath(command);
  if (fullPath) {
    // Match real shells: exec the resolved path but keep argv[0] as the
    // command name the user typed.
    spawnSync(fullPath, args, { stdio: "inherit", argv0: command });
    rl.prompt();
    return;
  }

  console.log(`${command}: command not found`);
  rl.prompt();
});

rl.on("close", () => {
  process.exit(0);
});
