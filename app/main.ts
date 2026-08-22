import { createInterface } from "readline";
import { accessSync, closeSync, constants, openSync, writeSync } from "fs";
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

// Tokenize a command line: split on unquoted whitespace; treat characters
// inside single or double quotes literally (whitespace preserved); adjacent
// quoted/unquoted segments concatenate into a single argument.
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let i = 0;

  while (i < input.length) {
    const char = input[i];
    if (char === "'") {
      inToken = true;
      i++;
      while (i < input.length && input[i] !== "'") {
        current += input[i];
        i++;
      }
      i++; // skip the closing quote
    } else if (char === '"') {
      inToken = true;
      i++;
      while (i < input.length && input[i] !== '"') {
        // Inside double quotes, a backslash only escapes " and \;
        // any other \x sequence keeps both characters literally.
        if (
          input[i] === "\\" &&
          i + 1 < input.length &&
          (input[i + 1] === '"' || input[i + 1] === "\\")
        ) {
          current += input[i + 1];
          i += 2;
        } else {
          current += input[i];
          i++;
        }
      }
      i++; // skip the closing quote
    } else if (char === "\\") {
      // Outside quotes, a backslash escapes the next character literally.
      inToken = true;
      i++;
      if (i < input.length) {
        current += input[i];
        i++;
      }
    } else if (char === ">") {
      // Unquoted > is a redirection operator. A lone "1" immediately
      // before it is the explicit stdout fd notation "1>".
      if (current === "1") {
        current = "";
        tokens.push("1>");
      } else {
        if (inToken) {
          tokens.push(current);
          current = "";
        }
        tokens.push(">");
      }
      inToken = false;
      i++;
    } else if (char === " " || char === "\t") {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      i++;
    } else {
      inToken = true;
      current += char;
      i++;
    }
  }
  if (inToken) tokens.push(current);
  return tokens;
}

rl.on("line", (input: string) => {
  const tokens = tokenize(input.trim());
  if (tokens.length === 0) {
    rl.prompt();
    return;
  }
  const [command, ...args] = tokens;

  if (command === "exit") {
    rl.close();
    return;
  }

  // Extract stdout redirection: "> file" or "1> file".
  let redirectPath: string | null = null;
  const cmdArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === ">" || args[i] === "1>") && i + 1 < args.length) {
      redirectPath = args[i + 1];
      i++;
    } else {
      cmdArgs.push(args[i]);
    }
  }

  let redirectFd: number | null = null;
  if (redirectPath) {
    try {
      redirectFd = openSync(redirectPath, "w");
    } catch {
      console.log(`cd: ${redirectPath}: No such file or directory`);
      rl.prompt();
      return;
    }
  }

  // Route stdout lines to the redirected file when one is set.
  const out = (text: string): void => {
    if (redirectFd !== null) {
      writeSync(redirectFd, `${text}\n`);
    } else {
      console.log(text);
    }
  };

  if (command === "echo") {
    out(cmdArgs.join(" "));
    if (redirectFd !== null) closeSync(redirectFd);
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
    out(process.cwd());
    if (redirectFd !== null) closeSync(redirectFd);
    rl.prompt();
    return;
  }

  if (command === "type") {
    const target = cmdArgs[0];
    if (target && BUILTINS.has(target)) {
      out(`${target} is a shell builtin`);
    } else if (target) {
      const fullPath = findExecutableInPath(target);
      if (fullPath) {
        out(`${target} is ${fullPath}`);
      } else {
        out(`${target}: not found`);
      }
    }
    if (redirectFd !== null) closeSync(redirectFd);
    rl.prompt();
    return;
  }

  const fullPath = findExecutableInPath(command);
  if (fullPath) {
    // Match real shells: exec the resolved path but keep argv[0] as the
    // command name the user typed.
    spawnSync(fullPath, cmdArgs, {
      stdio:
        redirectFd !== null ? ["inherit", redirectFd, "inherit"] : "inherit",
      argv0: command,
    });
    if (redirectFd !== null) closeSync(redirectFd);
    rl.prompt();
    return;
  }

  console.log(`${command}: command not found`);
  rl.prompt();
});

rl.on("close", () => {
  process.exit(0);
});
