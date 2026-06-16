import { job, workflow } from "@dedalus-labs/hollywood";

const CHECKOUT_V4 = "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5";
const SETUP_PYTHON_V5 = "actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065";

export const updateProfile = workflow({
	name: "Update profile README",
	on: {
		workflow_dispatch: {},
		schedule: [{ cron: "17 13 * * *" }],
	},
	permissions: { contents: "write" },
	jobs: {
		update: job({
			"runs-on": "ubuntu-latest",
			steps: [
				{ uses: CHECKOUT_V4 },
				{
					uses: SETUP_PYTHON_V5,
					with: { "python-version": "3.12" },
				},
				{
					run: "python scripts/update_profile_readme.py",
					env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
				},
				{
					name: "Commit changes",
					run: [
						"if git diff --quiet; then",
						"  exit 0",
						"fi",
						"",
						'git config user.name "github-actions[bot]"',
						'git config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
						"git add profile/README.md",
						'git commit -m "docs(profile): update repository stats"',
						"git push",
					].join("\n"),
				},
			],
		}),
	},
});
