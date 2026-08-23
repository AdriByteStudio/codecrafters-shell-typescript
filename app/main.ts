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
import { spawn, spawnSync } from "child_process";

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
  // The word immediately before the one being completed (e.g. "git" for
  // "git pu"); empty when no word precedes the cursor.
  const previousWord =
    wordsBefore.length > 0 ? wordsBefore[wordsBefore.length - 1] : "";
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

const BUILTINS = new Set([
  "echo",
  "exit",
  "type",
  "pwd",
  "cd",
  "complete",
  "jobs",
  "history",
]);

// Programmable completions registered with `complete -C <script> <command>`:
// maps the command name to its completer script path.
const completions = new Map<string, string>();

// Background jobs started with a trailing "&", numbered sequentially from 1.
interface Job {
  id: number;
  pid: number | undefined;
  command: string;
  status: "Running" | "Done";
}
const jobs: Job[] = [];

// Command history for the `history` builtin: every non-empty executed line,
// including the `history` invocation itself (like bash).
const historyList: string[] = [];

// Render the `history` listing: right-aligned entry numbers of width five,
// two spaces, then the command text.
function formatHistory(): string {
  return historyList
    .map((cmd, index) => `${String(index + 1).padStart(5, " ")}  ${cmd}`)
    .join("\n");
}

// Print a Done line for every finished background job and drop those jobs
// from the table. Used both by automatic reaping before each prompt and by
// the jobs builtin, so a Done entry is displayed exactly once.
function reapJobs(): void {
  if (!jobs.some((job) => job.status === "Done")) return;
  const ids = jobs.map((j) => j.id);
  const lastId = Math.max(...ids);
  const prevId =
    ids.length > 1 ? Math.max(...ids.filter((id) => id !== lastId)) : -2;
  for (const job of jobs) {
    if (job.status !== "Done") continue;
    const marker = job.id === lastId ? "+" : job.id === prevId ? "-" : " ";
    process.stdout.write(
      `[${job.id}]${marker}  ${job.status.padEnd(24, " ")}${job.command}\n`
    );
  }
  for (let i = jobs.length - 1; i >= 0; i--) {
    if (jobs[i].status === "Done") jobs.splice(i, 1);
  }
}

// Show the next prompt, reaping any completed background jobs first so
// their Done lines appear between the command output and the prompt.
function showPrompt(): void {
  reapJobs();
  rl.prompt();
}

// Render echo's full output (including -n/-e/-E flag handling) as text.
// Shared by the standalone builtin handler and pipeline execution.
function formatEchoOutput(cmdArgs: string[]): string {
  let newline = true;
  let interpretEscapes = false;
  let argIndex = 0;
  while (
    argIndex < cmdArgs.length &&
    cmdArgs[argIndex].length > 1 &&
    /^-[neE]+$/.test(cmdArgs[argIndex])
  ) {
    for (const flagChar of cmdArgs[argIndex].slice(1)) {
      if (flagChar === "n") newline = false;
      else if (flagChar === "e") interpretEscapes = true;
      else interpretEscapes = false;
    }
    argIndex++;
  }
  let text = cmdArgs.slice(argIndex).join(" ");
  if (interpretEscapes) {
    // Single pass so "\\\\" and "\\n" don't interfere with each other.
    text = text.replace(/\\(.)/g, (match, ch: string) => {
      switch (ch) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        case "a":
          return "\x07";
        case "b":
          return "\b";
        case "f":
          return "\f";
        case "v":
          return "\v";
        case "\\":
          return "\\";
        default:
          return match;
      }
    });
  }
  return text + (newline ? "\n" : "");
}

// Compute what a built-in prints when it runs as a pipeline member. Built-ins
// here never read stdin, so only their output matters; side effects (cd,
// jobs, complete, exit) are skipped, matching bash's subshell semantics.
function builtinPipelineOutput(name: string, cmdArgs: string[]): string {
  if (name === "echo") return formatEchoOutput(cmdArgs);
  if (name === "pwd") return `${process.cwd()}\n`;
  if (name === "history") {
    const text = formatHistory();
    return text.length > 0 ? `${text}\n` : "";
  }
  if (name === "type") {
    const target = cmdArgs[0];
    if (!target) return "";
    if (BUILTINS.has(target)) return `${target} is a shell builtin\n`;
    const fullPath = findExecutableInPath(target);
    if (fullPath) return `${target} is ${fullPath}\n`;
    return `${target}: not found\n`;
  }
  return "";
}

// Execute a pipeline, wiring each member's stdout to the next member's
// stdin. Members may be external commands or shell built-ins; built-ins run
// in-process with their captured output injected into the stream. Waits for
// every external member to finish before the next prompt. Each segment
// supports its own > >> 2> 2>> redirections.
function runPipeline(segments: string[][]): void {
  void (async () => {
    const runs: {
      name: string;
      isBuiltin: boolean;
      fullPath: string | null;
      cmdArgs: string[];
      stdoutPath: string | null;
      stdoutAppend: boolean;
      stderrPath: string | null;
      stderrAppend: boolean;
    }[] = [];
    for (const segment of segments) {
      const [name, ...rest] = segment;
      let stdoutPath: string | null = null;
      let stdoutAppend = false;
      let stderrPath: string | null = null;
      let stderrAppend = false;
      const cmdArgs: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const tok = rest[i];
        if ((tok === ">" || tok === "1>") && i + 1 < rest.length) {
          stdoutPath = rest[++i];
        } else if ((tok === ">>" || tok === "1>>") && i + 1 < rest.length) {
          stdoutPath = rest[++i];
          stdoutAppend = true;
        } else if (tok === "2>" && i + 1 < rest.length) {
          stderrPath = rest[++i];
        } else if (tok === "2>>" && i + 1 < rest.length) {
          stderrPath = rest[++i];
          stderrAppend = true;
        } else {
          cmdArgs.push(tok);
        }
      }
      if (name && BUILTINS.has(name)) {
        runs.push({
          name,
          isBuiltin: true,
          fullPath: null,
          cmdArgs,
          stdoutPath,
          stdoutAppend,
          stderrPath,
          stderrAppend,
        });
        continue;
      }
      const fullPath = name ? findExecutableInPath(name) : null;
      if (!fullPath || !name) {
        console.log(`${name}: command not found`);
        showPrompt();
        return;
      }
      runs.push({
        name,
        isBuiltin: false,
        fullPath,
        cmdArgs,
        stdoutPath,
        stdoutAppend,
        stderrPath,
        stderrAppend,
      });
    }

    const openRedirect = (
      target: string | null,
      append: boolean
    ): number | null => {
      if (!target) return null;
      try {
        return openSync(target, append ? "a" : "w");
      } catch {
        console.log(`cannot open ${target}`);
        return null;
      }
    };

    const children: ReturnType<typeof spawn>[] = [];
    const fdsToClose: number[] = [];
    // Output produced by built-in members that still has to flow to the
    // next member of the pipeline.
    let pendingOutput = "";
    // The most recent spawned child whose stdout hasn't been routed yet.
    let lastChild: ReturnType<typeof spawn> | null = null;

    // A built-in consumes no stdin, so any upstream member's data goes
    // nowhere; emulate bash by closing its stdout and SIGPIPE-ing it.
    const discardUpstream = (): void => {
      if (!lastChild) return;
      lastChild.stdout?.destroy();
      if (lastChild.exitCode === null && lastChild.signalCode === null) {
        lastChild.kill("SIGPIPE");
      }
      lastChild = null;
    };

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const isLast = i === runs.length - 1;

      if (run.isBuiltin) {
        discardUpstream();
        pendingOutput += builtinPipelineOutput(run.name, run.cmdArgs);
        if (isLast && pendingOutput.length > 0) {
          const outFd =
            run.stdoutPath !== null
              ? openRedirect(run.stdoutPath, run.stdoutAppend)
              : null;
          if (outFd !== null) {
            writeSync(outFd, pendingOutput);
            fdsToClose.push(outFd);
          } else {
            process.stdout.write(pendingOutput);
          }
          pendingOutput = "";
        }
        continue;
      }

      const outFd =
        run.stdoutPath !== null
          ? openRedirect(run.stdoutPath, run.stdoutAppend)
          : null;
      if (outFd !== null) fdsToClose.push(outFd);
      const errFd =
        run.stderrPath !== null
          ? openRedirect(run.stderrPath, run.stderrAppend)
          : null;
      if (errFd !== null) fdsToClose.push(errFd);
      // stdin source: inherited terminal for the first member, piped data
      // from a preceding external, or buffered output from a preceding
      // built-in.
      const feedsFromLastChild = lastChild !== null;
      const child = spawn(run.fullPath!, run.cmdArgs, {
        stdio: [
          i === 0 ? "inherit" : "pipe",
          outFd !== null ? outFd : isLast ? "inherit" : "pipe",
          errFd !== null ? errFd : "inherit",
        ],
        argv0: run.name,
      });
      // A downstream member may exit early (e.g. `head`); ignore the
      // resulting EPIPE errors on the parent-side pipe ends instead of
      // crashing. Upstream processes are signalled below on exit.
      child.stdin?.on("error", () => {});
      child.stdout?.on("error", () => {});
      children.push(child);
      if (feedsFromLastChild && outFd === null) {
        lastChild!.stdout!.pipe(child.stdin!);
      } else if (pendingOutput.length > 0) {
        child.stdin?.write(pendingOutput);
        child.stdin?.end();
        pendingOutput = "";
      }
      lastChild = child;
    }

    // Emulate OS-level pipeline teardown when a member exits: give the
    // downstream member EOF (destroy the writable feeding its stdin) and
    // deliver SIGPIPE to the upstream member, whose writes could no longer
    // go anywhere. Exactly what the kernel does with real pipe fds.
    children.forEach((child, index) => {
      child.on("exit", () => {
        children[index]?.stdin?.destroy();
        children[index - 1]?.stdout?.destroy();
        const prev = children[index - 1];
        if (prev && prev.exitCode === null && prev.signalCode === null) {
          prev.kill("SIGPIPE");
        }
      });
    });

    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            let settled = false;
            const done = () => {
              if (!settled) {
                settled = true;
                resolve();
              }
            };
            child.on("exit", done);
            child.on("error", done);
          })
      )
    );
    for (const fd of fdsToClose) closeSync(fd);
    showPrompt();
  })();
}

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
    } else if (char === "|") {
      // Unquoted | is a pipeline operator.
      if (inToken) {
        tokens.push(current);
        current = "";
      }
      tokens.push("|");
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
  // A fresh line starts a new completion sequence.
  lastTabWord = null;
  const tokens = tokenize(input.trim());
  if (tokens.length === 0) {
    showPrompt();
    return;
  }

  // Record every non-empty executed line for the `history` builtin. The
  // current line is included before dispatch, so `history` lists itself too.
  historyList.push(input.trim());

  // Split the line into pipeline segments on unquoted "|" tokens.
  const segments: string[][] = [[]];
  for (const tok of tokens) {
    if (tok === "|") segments.push([]);
    else segments[segments.length - 1].push(tok);
  }
  if (segments.length > 1) {
    runPipeline(segments);
    return;
  }

  const [command, ...args] = tokens;

  // A trailing "&" runs the remaining command in the background.
  const isBackground = args.length > 0 && args[args.length - 1] === "&";
  if (isBackground) args.pop();

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

  // Like out(), but writes text verbatim without appending a newline.
  const outRaw = (text: string): void => {
    if (redirectFd !== null) {
      writeSync(redirectFd, text);
    } else {
      process.stdout.write(text);
    }
  };

  if (command === "echo") {
    outRaw(formatEchoOutput(cmdArgs));
    if (redirectFd !== null) closeSync(redirectFd);
    if (errFd !== null) closeSync(errFd);
    showPrompt();
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
    showPrompt();
    return;
  }

  if (command === "pwd") {
    out(process.cwd());
    if (redirectFd !== null) closeSync(redirectFd);
    if (errFd !== null) closeSync(errFd);
    showPrompt();
    return;
  }

  if (command === "history") {
    const text = formatHistory();
    if (text) out(text);
    if (redirectFd !== null) closeSync(redirectFd);
    if (errFd !== null) closeSync(errFd);
    showPrompt();
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
    showPrompt();
    return;
  }

  if (command === "complete") {
    // "-C <script> <command>" registers a completer; "-r <command>" removes
    // its rule (silently, even if none exists); "-p <command>" prints the
    // stored spec in normalized form (single quotes around the path, single
    // spaces) or reports that none is registered.
    const cIndex = cmdArgs.indexOf("-C");
    const rIndex = cmdArgs.indexOf("-r");
    const pIndex = cmdArgs.indexOf("-p");
    if (cIndex !== -1 && cmdArgs[cIndex + 1] && cmdArgs[cIndex + 2]) {
      completions.set(cmdArgs[cIndex + 2], cmdArgs[cIndex + 1]);
    } else if (rIndex !== -1 && cmdArgs[rIndex + 1]) {
      completions.delete(cmdArgs[rIndex + 1]);
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
    showPrompt();
    return;
  }

  if (command === "jobs") {
    // Format: [id]<marker>  <status padded to 24>  <command>[ &]
    // Markers: "+" most recent job, "-" second most recent, " " others.
    // Running jobs keep the trailing "&"; Done entries drop it.
    const ids = jobs.map((j) => j.id);
    const lastId = ids.length > 0 ? Math.max(...ids) : -1;
    const prevId =
      ids.length > 1 ? Math.max(...ids.filter((id) => id !== lastId)) : -2;
    for (const job of jobs) {
      const marker = job.id === lastId ? "+" : job.id === prevId ? "-" : " ";
      const status = job.status.padEnd(24, " ");
      const suffix = job.status === "Running" ? " &" : "";
      out(`[${job.id}]${marker}  ${status}${job.command}${suffix}`);
    }
    // Reap finished jobs so they vanish from subsequent listings.
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (jobs[i].status === "Done") jobs.splice(i, 1);
    }
    if (redirectFd !== null) closeSync(redirectFd);
    if (errFd !== null) closeSync(errFd);
    showPrompt();
    return;
  }

  const fullPath = findExecutableInPath(command);
  if (fullPath) {
    // Match real shells: exec the resolved path but keep argv[0] as the
    // command name the user typed.
    if (isBackground) {
      // Don't wait for the child; report its job number and PID at once.
      const child = spawn(fullPath, cmdArgs, {
        stdio: ["inherit", redirectFd !== null ? redirectFd : "inherit", errFd !== null ? errFd : "inherit"],
        argv0: command,
      });
      const job: Job = {
        // Recycled numbering: [1] for an empty table, otherwise one more
        // than the highest number still in it.
        id: jobs.length === 0 ? 1 : Math.max(...jobs.map((j) => j.id)) + 1,
        pid: child.pid,
        command: [command, ...cmdArgs].join(" "),
        status: "Running",
      };
      // Node reaps the child automatically; record normal exits so `jobs`
      // can report them as Done and drop them from the table.
      child.on("exit", (_code, signal) => {
        if (signal === null) job.status = "Done";
      });
      jobs.push(job);
      out(`[${job.id}] ${child.pid}`);
      if (redirectFd !== null) closeSync(redirectFd);
      if (errFd !== null) closeSync(errFd);
      showPrompt();
      return;
    }
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
    showPrompt();
    return;
  }

  console.log(`${command}: command not found`);
  showPrompt();
});

rl.on("close", () => {
  process.exit(0);
});
