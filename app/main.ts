import { createInterface } from "readline";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
});

rl.prompt();

const BUILTINS = new Set(["echo", "exit", "type"]);

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

  if (command === "type") {
    const target = args[0];
    if (target && BUILTINS.has(target)) {
      console.log(`${target} is a shell builtin`);
    } else if (target) {
      console.log(`${target}: not found`);
    }
    rl.prompt();
    return;
  }

  console.log(`${command}: command not found`);
  rl.prompt();
});

rl.on("close", () => {
  process.exit(0);
});
