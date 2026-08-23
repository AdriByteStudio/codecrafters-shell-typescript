import { createInterface } from "readline";
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readdirSync,
  statSync,
  writeSync,
} from "fs";
import path from "path";
import { spawnSync } from "child_process";

// Collect executable file names in PATH directories that start with `word`.
// Missing/unreadable directories are skipped gracefully.
function findExecutableCompletions(word: string): string[] {
  const names = new Set<string>();
  const dirs = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  for (const dir of dirs) {
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith(word) || names.has(name)) continue;
      try {
        accessSync(path.join(dir, name), constants.F_OK | constants.X_OK);
        names.add(name);
      } catch {
        // Not a file we can execute; skip.
      }
    }
  }
  return [...names].sort();
}

// Collect file names matching the last word of an argument. The word may
// include a directory part ("path/to/f"): everything up to and including the
// last "/" selects the directory to list, the rest is the prefix. Returned
// completions keep the directory part so they replace the whole word.
// Hidden files only match when the typed prefix itself starts with a dot.
function findFilenameCompletions(word: string): string[] {
  const slash = word.lastIndexOf("/");
  const dirPart = slash === -1 ? "" : word.slice(0, slash + 1);
  const prefix = slash === -1 ? word : word.slice(slash + 1);
  let entries: string[];
  try {
    entries = readdirSync(dirPart === "" ? process.cwd() : dirPart);
  } catch {
    return [];
  }
  return entries
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        (prefix.startsWith(".") || !name.startsWith("."))
    )
    .map((name) => dirPart + name)
    .sort();
}

// Runs a registered completer script, passing the completion context as
// arguments (<command> <current word> <previous word>) plus COMP_LINE and
// COMP_POINT environment variables (full line text and cursor byte index).
// Returns its non-empty stdout lines, each one a completion candidate.
// Failures yield no candidates.
function runCompleterScript(
  script: string,
  commandName: string,
  currentWord: string,
  previousWord: string,
  line: string
): string[] {
  try {
    const result = spawnSync(script, [commandName, currentWord, previousWord], {
      encoding: "utf8",
      env: {
        ...process.env,
        COMP_LINE: line,
        // TAB fires at end of line, so the cursor sits at the last byte.
        COMP_POINT: String(Buffer.byteLength(line)),
      },
    });
    return (result.stdout ?? "")
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l !== "")
      .sort();
  } catch {
    return [];
  }
}

// Format a filename match for display: directories get a trailing "/",
// files are shown bare. Unreadable entries fall back to their plain name.
function displayEntry(entry: string): string {
  try {
    return statSync(entry).isDirectory() ? `${entry}/` : entry;
  } catch {
    return entry;
  }
}

// Longest common prefix shared by all strings (non-empty input assumed).
function longestCommonPrefix(strs: string[]): string {
  let prefix = strs[0];
  for (const s of strs) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

// Tracks the last word a <TAB> was pressed for, to distinguish the first
// tab (bell only) from subsequent tabs (list all matches).
let lastTabWord: string | null = null;

// Tab completion: complete builtin commands and PATH executables, adding a
// trailing space so the user can immediately type arguments. With no match,
// leave the input unchanged and ring the terminal bell. With multiple
// matches, ring the bell on the first tab and list them alphabetically on
// the next tab.
function completer(line: string): [string[], string] {
  // Node passes the whole line; only the last word gets completed.
  const wordMatch = /(\S*)$/.exec(line);
  const word = wordMatch ? wordMatch[1] : "";
  // Everything before the last word; if it is only whitespace, the word
  // being completed sits in command position, otherwise it is an argument.
  const beforeWord = line.slice(0, line.length - word.length);
  const isCommandPosition = beforeWord.trim() === "";

  // A completer registered for the line's command takes precedence over
  // built-in filename/command completion. Its candidates are inserted
  // verbatim, so directories are never decorated with a trailing "/".
  const wordsBefore = beforeWord.trim() ? beforeWord.trim().split(/\s+/) : [];
  const cmdName = wordsBefore.length > 0 ? wordsBefore[0] : null;
  const previousWord =
    wordsBefore.length > 1 ? wordsBefore[wordsBefore.length - 1] : "";
  const script = cmdName !== null ? completions.get(cmdName) : undefined;
  const decorateDirectories = script === undefined && !isCommandPosition;

  const hits =
    script !== undefined && cmdName !== null
      ? runCompleterScript(script, cmdName, word, previousWord, line)
      : isCommandPosition
      ? [
          ...new Set([
            ...[...BUILTINS].filter((c) => c.startsWith(word)),
            ...findExecutableCompletions(word),
          ]),
        ].sort()
      : findFilenameCompletions(word);

  // Always report "no completions" to readline and perform the desired
  // effect ourselves; bun's built-in completion insertion is unreliable.
  if (hits.length === 1) {
    lastTabWord = null;
    // Directories complete with a trailing "/" (no space) so the user can
    // immediately tab again into the next path level; files get a space.
    let suffix = " ";
    if (decorateDirectories) {
      try {
        if (statSync(hits[0]).isDirectory()) suffix = "/";
      } catch {
        // Unreadable or vanished entry: fall back to a trailing space.
      }
    }
    // Complete in place with the appropriate suffix, as if the user typed it.
    rl.write(`${hits[0].slice(word.length)}${suffix}`);
    return [[], line];
  }

  if (hits.length === 0) {
    lastTabWord = null;
    process.stdout.write("\x07"); // bell: no valid completions
    return [[], line];
  }

  // Multiple matches: if they share a common prefix longer than what the
  // user typed, complete up to it. Otherwise ring the bell on the first
  // tab and list all matches alphabetically on the next tab.
  const lcp = longestCommonPrefix(hits);
  if (lcp.length > word.length) {
    lastTabWord = null;
    rl.write(lcp.slice(word.length));
    return [[], line];
  }
  if (lastTabWord !== word) {
    lastTabWord = word;
    process.stdout.write("\x07");
    return [[], line];
  }
  // Keep tracking the word so every subsequent tab re-lists the matches.
  // Directories are decorated with a trailing "/"; sorting stays by raw name.
  const shown = decorateDirectories ? hits.map(displayEntry) : hits;
  process.stdout.write(`\n${shown.join("  ")}\n`);
  rl.prompt(true);
  return [[], line];
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
  completer,
});

rl.prompt();

const BUILTINS = new Set(["echo", "exit", "type", "pwd", "cd", "complete"]);

// Programmable completions registered with `complete -C <script> <command>`:
// maps the command name to its completer script path.
const completions = new Map<string, string>();

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
      // Unquoted > is a redirection operator. A lone "1" or "2"
      // immediately before it selects the fd. A doubled ">" means append.
      const isAppend = input[i + 1] === ">";
      const op = isAppend ? ">>" : ">";
      if (current === "1" || current === "2") {
        tokens.push(`${current}${op}`);
        current = "";
      } else {
        if (inToken) {
          tokens.push(current);
          current = "";
        }
        tokens.push(op);
      }
      inToken = false;
      i += op.length;
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
  // A fresh line starts a new completion sequence.
  lastTabWord = null;
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

  // Extract redirections: ">/1>" (stdout, truncate), ">>/1>>" (stdout,
  // append), "2>"/"2>>" (stderr, truncate/append).
  let stdoutPath: string | null = null;
  let stdoutAppend = false;
  let stderrPath: string | null = null;
  let stderrAppend = false;
  const cmdArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if ((tok === ">" || tok === "1>") && i + 1 < args.length) {
      stdoutPath = args[++i];
    } else if ((tok === ">>" || tok === "1>>") && i + 1 < args.length) {
      stdoutPath = args[++i];
      stdoutAppend = true;
    } else if (tok === "2>" && i + 1 < args.length) {
      stderrPath = args[++i];
    } else if (tok === "2>>" && i + 1 < args.length) {
      stderrPath = args[++i];
      stderrAppend = true;
    } else {
      cmdArgs.push(tok);
    }
  }

  const openRedirect = (target: string | null, append: boolean): number | null => {
    if (!target) return null;
    try {
      return openSync(target, append ? "a" : "w");
    } catch {
      console.log(`cannot open ${target}`);
      return null;
    }
  };
  const redirectFd = openRedirect(stdoutPath, stdoutAppend);
  const errFd = openRedirect(stderrPath, stderrAppend);

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
    if (errFd !== null) closeSync(errFd);
    rl.prompt();
    return;
  }

  if (command === "cd") {
    const home = process.env.HOME;
    let target = args[0];
    if (target === "~" && home !== undefined) {
      target = home;
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
    if (errFd !== null) closeSync(errFd);
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
    if (errFd !== null) closeSync(errFd);
    rl.prompt();
    return;
  }

  if (command === "complete") {
    // "-C <script> <command>" registers a completer; "-p <command>" prints
    // the stored spec in normalized form (single quotes around the path,
    // single spaces) or reports that none is registered.
    const cIndex = cmdArgs.indexOf("-C");
    const pIndex = cmdArgs.indexOf("-p");
    if (cIndex !== -1 && cmdArgs[cIndex + 1] && cmdArgs[cIndex + 2]) {
      completions.set(cmdArgs[cIndex + 2], cmdArgs[cIndex + 1]);
    } else if (pIndex !== -1) {
      const target = cmdArgs[pIndex + 1];
      if (target) {
        const script = completions.get(target);
        if (script) {
          out(`complete -C '${script}' ${target}`);
        } else {
          out(`complete: ${target}: no completion specification`);
        }
      }
    }
    if (redirectFd !== null) closeSync(redirectFd);
    if (errFd !== null) closeSync(errFd);
    rl.prompt();
    return;
  }

  const fullPath = findExecutableInPath(command);
  if (fullPath) {
    // Match real shells: exec the resolved path but keep argv[0] as the
    // command name the user typed.
    spawnSync(fullPath, cmdArgs, {
      stdio: [
        "inherit",
        redirectFd !== null ? redirectFd : "inherit",
        errFd !== null ? errFd : "inherit",
      ],
      argv0: command,
    });
    if (redirectFd !== null) closeSync(redirectFd);
    if (errFd !== null) closeSync(errFd);
    rl.prompt();
    return;
  }

  console.log(`${command}: command not found`);
  rl.prompt();
});

rl.on("close", () => {
  process.exit(0);
});
