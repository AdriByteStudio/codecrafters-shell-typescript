import { createInterface } from "readline";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
});

rl.prompt();

rl.on("line", (input: string) => {
  const command = input.trim();
  if (command === "exit") {
    rl.close();
    return;
  }
  console.log(`${command}: command not found`);
  rl.prompt();
});

rl.on("close", () => {
  process.exit(0);
});
