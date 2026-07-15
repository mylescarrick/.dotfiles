import { application } from "./application";

const outcome = await application.execute({
  argv: Bun.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
});

if (outcome.stdout) {
  await Bun.write(Bun.stdout, outcome.stdout);
}
if (outcome.stderr) {
  await Bun.write(Bun.stderr, outcome.stderr);
}

process.exitCode = outcome.exitCode;
