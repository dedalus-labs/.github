import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Command } from "commander";

import { updateProfileReadme } from "./update-profile-readme.js";

type RunOptions = Readonly<{
	command: string;
	args: readonly string[];
}>;

type WorkflowOptions = Readonly<{
	sourceRoot: string;
	output: string;
}>;

const WORKFLOW_SOURCE = "scripts/update-profile.ts";

const run = ({ command, args }: RunOptions): Promise<number> =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));
	});

const setExitCode = async (action: Promise<number>): Promise<void> => {
	process.exitCode = await action;
};

const hollywood = (subcommand: "generate" | "check", options: WorkflowOptions): Promise<number> =>
	run({
		command: "npm",
		args: [
			"exec",
			"--",
			"hollywood",
			subcommand,
			...(subcommand === "generate" ? [WORKFLOW_SOURCE] : []),
			"--source-root",
			options.sourceRoot,
			"--output",
			options.output,
		],
	});

export const program = new Command()
	.name("dedalus-github")
	.description("Dedalus Labs GitHub profile tooling.")
	.showHelpAfterError()
	.showSuggestionAfterError();

program
	.command("typecheck")
	.description("Run TypeScript typechecking.")
	.action(async () => {
		await setExitCode(run({ command: "npm", args: ["exec", "--", "tsc", "--noEmit"] }));
	});

program
	.command("profile")
	.description("Profile README commands.")
	.command("update")
	.description("Update the generated repository catalog.")
	.action(async () => {
		await updateProfileReadme();
	});

const workflows = program.command("workflows").description("Hollywood workflow commands.");

workflows
	.command("generate")
	.description("Generate GitHub Actions workflows from Hollywood sources.")
	.option("--source-root <path>", "Hollywood source root.", "scripts")
	.option("--output <path>", "Generated workflow output root.", ".")
	.action(async (options: WorkflowOptions) => {
		await setExitCode(hollywood("generate", options));
	});

workflows
	.command("check")
	.description("Validate generated workflows and workflow security.")
	.option("--source-root <path>", "Hollywood source root.", "scripts")
	.option("--output <path>", "Generated workflow output root.", ".")
	.action(async (options: WorkflowOptions) => {
		await setExitCode(hollywood("check", options));
	});

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await program.parseAsync(process.argv);
}
