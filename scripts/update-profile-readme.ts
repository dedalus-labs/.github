import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ORG = "dedalus-labs";
const README = resolve(dirname(fileURLToPath(import.meta.url)), "../profile/README.md");
const START = "<!-- sdk-repositories:start -->";
const END = "<!-- sdk-repositories:end -->";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

type Repo = Readonly<{
	name: string;
	description: string | null;
	url: string;
	stargazerCount: number;
	openIssues: number;
	openPullRequests: number;
}>;

type Group = Readonly<{
	title: string;
	repos: readonly string[];
}>;

const ICONS = {
	repo: "https://raw.githubusercontent.com/primer/octicons/main/icons/repo-16.svg",
	star: "https://raw.githubusercontent.com/primer/octicons/main/icons/star-16.svg",
	issue: "https://raw.githubusercontent.com/primer/octicons/main/icons/issue-opened-16.svg",
	pr: "https://raw.githubusercontent.com/primer/octicons/main/icons/git-pull-request-16.svg",
} as const;

const GROUPS = [
	{
		title: "Dedalus SDKs",
		repos: [
			"dedalus-python",
			"dedalus-typescript",
			"dedalus-go",
			"dedalus-csharp",
			"dedalus-java",
			"dedalus-kotlin",
			"dedalus-php",
			"dedalus-ruby",
			"dedalus-sql",
			"dedalus-openapi",
		],
	},
	{
		title: "Developer Tools",
		repos: ["wingman", "dedalus-cli", "terraform-provider-dedalus", "homebrew-tap"],
	},
	{
		title: "Agents API SDKs",
		repos: [
			"dedalus-agents-python",
			"dedalus-agents-typescript",
			"dedalus-agents-go",
			"dedalus-agents-csharp",
			"dedalus-agents-java",
			"dedalus-agents-kotlin",
			"dedalus-agents-php",
			"dedalus-agents-ruby",
			"dedalus-agents-sql",
			"dedalus-agents-openapi",
			"dedalus-agents-cli",
		],
	},
] satisfies readonly Group[];

const REPOS_QUERY = `
query($org: String!, $after: String) {
  organization(login: $org) {
    repositories(
      first: 100
      after: $after
      privacy: PUBLIC
      orderBy: {field: NAME, direction: ASC}
    ) {
      nodes {
        name
        description
        url
        isArchived
        isFork
        stargazerCount
        issues(states: OPEN) { totalCount }
        pullRequests(states: OPEN) { totalCount }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
`;

class ProfileReadmeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProfileReadmeError";
	}
}

const githubToken = async (): Promise<string> => {
	const githubToken = process.env.GITHUB_TOKEN;
	if (githubToken !== undefined && githubToken.length > 0) {
		return githubToken;
	}

	const ghToken = process.env.GH_TOKEN;
	if (ghToken !== undefined && ghToken.length > 0) {
		return ghToken;
	}

	try {
		const { stdout } = await execFileAsync("gh", ["auth", "token"], { encoding: "utf8" });
		const token = stdout.trim();
		if (token.length === 0) {
			throw new ProfileReadmeError("gh auth token returned an empty token");
		}
		return token;
	} catch (error) {
		if (error instanceof ProfileReadmeError) {
			throw error;
		}
		throw new ProfileReadmeError("set GITHUB_TOKEN or GH_TOKEN, or authenticate gh");
	}
};

const expectRecord = (value: Json | undefined, field: string): JsonRecord => {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return value;
	}
	throw new ProfileReadmeError(`${field} must be an object`);
};

const expectArray = (value: Json | undefined, field: string): Json[] => {
	if (Array.isArray(value)) {
		return value;
	}
	throw new ProfileReadmeError(`${field} must be a list`);
};

const expectString = (value: Json | undefined, field: string): string => {
	if (typeof value === "string") {
		return value;
	}
	throw new ProfileReadmeError(`${field} must be a string`);
};

const expectOptionalString = (value: Json | undefined, field: string): string | null => {
	if (value === null || value === undefined) {
		return null;
	}
	return expectString(value, field);
};

const expectNumber = (value: Json | undefined, field: string): number => {
	if (typeof value === "number" && Number.isInteger(value)) {
		return value;
	}
	throw new ProfileReadmeError(`${field} must be an integer`);
};

const expectBoolean = (value: Json | undefined, field: string): boolean => {
	if (typeof value === "boolean") {
		return value;
	}
	throw new ProfileReadmeError(`${field} must be a boolean`);
};

const graphql = async (
	query: string,
	variables: JsonRecord,
	options: Readonly<{ token: string }>,
): Promise<JsonRecord> => {
	const response = await fetch("https://api.github.com/graphql", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${options.token}`,
			"Content-Type": "application/json",
			"User-Agent": "dedalus-profile-readme-updater",
		},
		body: JSON.stringify({ query, variables }),
	});

	if (!response.ok) {
		const detail = await response.text();
		throw new ProfileReadmeError(`GitHub GraphQL returned ${response.status}: ${detail}`);
	}

	const body = expectRecord((await response.json()) as Json, "body");
	const errors = body.errors;
	if (errors !== undefined) {
		const messages = graphqlErrorMessages(expectArray(errors, "errors"));
		throw new ProfileReadmeError(messages.length > 0 ? messages.join("; ") : "GitHub GraphQL returned errors");
	}

	return expectRecord(body.data, "data");
};

const graphqlErrorMessages = (errors: readonly Json[]): string[] => {
	const messages: string[] = [];
	for (const error of errors) {
		const data = expectRecord(error, "error");
		const message = data.message;
		if (typeof message === "string") {
			messages.push(message);
		}
	}
	return messages;
};

const publicRepos = async (options: Readonly<{ token: string }>): Promise<Map<string, Repo>> => {
	const repos = new Map<string, Repo>();
	let after: string | null = null;

	for (;;) {
		const data = await graphql(REPOS_QUERY, { org: ORG, after }, options);
		const org = expectRecord(data.organization, "organization");
		const repositories = expectRecord(org.repositories, "repositories");
		const nodes = expectArray(repositories.nodes, "repositories.nodes");

		for (const node of nodes) {
			const raw = expectRecord(node, "repository");
			if (expectBoolean(raw.isArchived, "repository.isArchived")) {
				continue;
			}
			if (expectBoolean(raw.isFork, "repository.isFork")) {
				continue;
			}
			const repo = parseRepo(raw);
			repos.set(repo.name, repo);
		}

		const pageInfo = expectRecord(repositories.pageInfo, "repositories.pageInfo");
		if (!expectBoolean(pageInfo.hasNextPage, "pageInfo.hasNextPage")) {
			return repos;
		}
		after = expectOptionalString(pageInfo.endCursor, "pageInfo.endCursor");
	}
};

const parseRepo = (raw: JsonRecord): Repo => {
	const issues = expectRecord(raw.issues, "repository.issues");
	const pullRequests = expectRecord(raw.pullRequests, "repository.pullRequests");

	return {
		name: expectString(raw.name, "repository.name"),
		description: expectOptionalString(raw.description, "repository.description"),
		url: expectString(raw.url, "repository.url"),
		stargazerCount: expectNumber(raw.stargazerCount, "repository.stargazerCount"),
		openIssues: expectNumber(issues.totalCount, "repository.issues.totalCount"),
		openPullRequests: expectNumber(pullRequests.totalCount, "repository.pullRequests.totalCount"),
	};
};

const markdownEscape = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");

const icon = (name: keyof typeof ICONS, label: string): string =>
	`<img alt="${label}" src="${ICONS[name]}" width="16" height="16">`;

const descriptionFor = (repo: Repo): string => repo.description?.replace(/\.$/, "") ?? "";

const row = (repo: Repo): string => {
	const description = markdownEscape(descriptionFor(repo));
	return `| [${repo.name}](${repo.url}) | ${description} | ${repo.stargazerCount} | ${repo.openIssues} | ${repo.openPullRequests} |`;
};

const table = (group: Group, repos: ReadonlyMap<string, Repo>): string => {
	const lines = [
		`### ${group.title}`,
		"",
		`| ${icon("repo", "Repository")} Repository | Description | ${icon("star", "Stars")} | ${icon("issue", "Open issues")} | ${icon("pr", "Open pull requests")} |`,
		"|------------|-------------|------:|-------:|----:|",
	];

	for (const name of group.repos) {
		const repo = repos.get(name);
		if (repo === undefined) {
			throw new ProfileReadmeError(`missing public repository: ${ORG}/${name}`);
		}
		lines.push(row(repo));
	}

	return lines.join("\n");
};

const render = (repos: ReadonlyMap<string, Repo>): string => {
	const tables = GROUPS.map((group) => table(group, repos)).join("\n\n");
	return `${START}\n<!-- This section is generated by scripts/update-profile-readme.ts. -->\n\n${tables}\n${END}`;
};

const replaceGeneratedBlock = (readme: string, block: string): string => {
	const start = readme.indexOf(START);
	const end = readme.indexOf(END);
	if (start === -1 || end === -1 || end < start) {
		throw new ProfileReadmeError(`profile README must contain ${START} and ${END}`);
	}
	return `${readme.slice(0, start)}${block}${readme.slice(end + END.length)}`;
};

export const updateProfileReadme = async (): Promise<void> => {
	const token = await githubToken();
	const repos = await publicRepos({ token });
	const readme = await readFile(README, "utf8");
	const block = render(repos);
	await writeFile(README, replaceGeneratedBlock(readme, block));
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await updateProfileReadme();
}
