from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import ssl
import subprocess
from typing import cast
import urllib.error
import urllib.request


ORG = "dedalus-labs"
README = Path(__file__).resolve().parents[1] / "profile" / "README.md"
START = "<!-- sdk-repositories:start -->"
END = "<!-- sdk-repositories:end -->"

Json = None | bool | int | float | str | list["Json"] | dict[str, "Json"]
JsonDict = dict[str, Json]


class ProfileReadmeError(RuntimeError):
    """Profile README update failed."""


@dataclass(frozen=True)
class Repo:
    name: str
    description: str | None
    url: str
    stargazer_count: int
    open_issues: int
    open_pull_requests: int


@dataclass(frozen=True)
class Group:
    title: str
    repos: tuple[str, ...]


ICONS = {
    "repo": "https://raw.githubusercontent.com/primer/octicons/main/icons/repo-16.svg",
    "star": "https://raw.githubusercontent.com/primer/octicons/main/icons/star-16.svg",
    "issue": "https://raw.githubusercontent.com/primer/octicons/main/icons/issue-opened-16.svg",
    "pr": "https://raw.githubusercontent.com/primer/octicons/main/icons/git-pull-request-16.svg",
}

GROUPS = (
    Group(
        title="Dedalus SDKs",
        repos=(
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
        ),
    ),
    Group(
        title="Developer Tools",
        repos=(
            "wingman",
            "dedalus-cli",
            "terraform-provider-dedalus",
            "homebrew-tap",
        ),
    ),
    Group(
        title="Agents API SDKs",
        repos=(
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
        ),
    ),
)

REPOS_QUERY = """
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
"""


def github_token() -> str:
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        return token

    token = os.environ.get("GH_TOKEN")
    if token:
        return token

    try:
        res = subprocess.run(
            ["gh", "auth", "token"],
            capture_output=True,
            check=True,
            text=True,
        )
    except FileNotFoundError as err:
        msg = "set GITHUB_TOKEN or GH_TOKEN, or install and authenticate gh"
        raise ProfileReadmeError(msg) from err
    except subprocess.CalledProcessError as err:
        msg = "set GITHUB_TOKEN or GH_TOKEN, or authenticate gh"
        raise ProfileReadmeError(msg) from err

    token = res.stdout.strip()
    if not token:
        msg = "gh auth token returned an empty token"
        raise ProfileReadmeError(msg)
    return token


def expect_dict(value: Json, field: str) -> JsonDict:
    if isinstance(value, dict):
        return value
    msg = f"{field} must be an object"
    raise ProfileReadmeError(msg)


def expect_list(value: Json, field: str) -> list[Json]:
    if isinstance(value, list):
        return value
    msg = f"{field} must be a list"
    raise ProfileReadmeError(msg)


def expect_str(value: Json, field: str) -> str:
    if isinstance(value, str):
        return value
    msg = f"{field} must be a string"
    raise ProfileReadmeError(msg)


def expect_optional_str(value: Json, field: str) -> str | None:
    if value is None:
        return None
    return expect_str(value, field)


def expect_int(value: Json, field: str) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    msg = f"{field} must be an integer"
    raise ProfileReadmeError(msg)


def expect_bool(value: Json, field: str) -> bool:
    if isinstance(value, bool):
        return value
    msg = f"{field} must be a boolean"
    raise ProfileReadmeError(msg)


def graphql(query: str, variables: JsonDict, *, token: str) -> JsonDict:
    payload = json.dumps({"query": query, "variables": variables}).encode()
    req = urllib.request.Request(
        "https://api.github.com/graphql",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "dedalus-profile-readme-updater",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30, context=ssl_context()) as res:
            body = cast(JsonDict, json.loads(res.read()))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        msg = f"GitHub GraphQL returned {err.code}: {detail}"
        raise ProfileReadmeError(msg) from err
    except urllib.error.URLError as err:
        msg = f"GitHub GraphQL request failed: {err.reason}"
        raise ProfileReadmeError(msg) from err

    errors = body.get("errors")
    if errors is not None:
        messages = graphql_error_messages(expect_list(errors, "errors"))
        msg = "; ".join(messages) if messages else "GitHub GraphQL returned errors"
        raise ProfileReadmeError(msg)

    return expect_dict(body.get("data"), "data")


def ssl_context() -> ssl.SSLContext:
    try:
        import certifi
    except ModuleNotFoundError:
        return ssl.create_default_context()

    return ssl.create_default_context(cafile=certifi.where())


def graphql_error_messages(errors: list[Json]) -> list[str]:
    messages: list[str] = []
    for error in errors:
        data = expect_dict(error, "error")
        message = data.get("message")
        if isinstance(message, str):
            messages.append(message)
    return messages


def public_repos(*, token: str) -> dict[str, Repo]:
    repos: dict[str, Repo] = {}
    after: str | None = None

    while True:
        data = graphql(REPOS_QUERY, {"org": ORG, "after": after}, token=token)
        org = expect_dict(data.get("organization"), "organization")
        repositories = expect_dict(org.get("repositories"), "repositories")
        nodes = expect_list(repositories.get("nodes"), "repositories.nodes")

        for node in nodes:
            raw = expect_dict(node, "repository")
            if expect_bool(raw.get("isArchived"), "repository.isArchived"):
                continue
            if expect_bool(raw.get("isFork"), "repository.isFork"):
                continue
            repo = parse_repo(raw)
            repos[repo.name] = repo

        page_info = expect_dict(repositories.get("pageInfo"), "repositories.pageInfo")
        if not expect_bool(page_info.get("hasNextPage"), "pageInfo.hasNextPage"):
            return repos
        after = expect_optional_str(page_info.get("endCursor"), "pageInfo.endCursor")


def parse_repo(raw: JsonDict) -> Repo:
    issues = expect_dict(raw.get("issues"), "repository.issues")
    pull_requests = expect_dict(raw.get("pullRequests"), "repository.pullRequests")

    return Repo(
        name=expect_str(raw.get("name"), "repository.name"),
        description=expect_optional_str(raw.get("description"), "repository.description"),
        url=expect_str(raw.get("url"), "repository.url"),
        stargazer_count=expect_int(raw.get("stargazerCount"), "repository.stargazerCount"),
        open_issues=expect_int(issues.get("totalCount"), "repository.issues.totalCount"),
        open_pull_requests=expect_int(
            pull_requests.get("totalCount"),
            "repository.pullRequests.totalCount",
        ),
    )


def markdown_escape(value: str) -> str:
    text = value.replace("|", "\\|").replace("\n", " ")
    return text


def icon(name: str, label: str) -> str:
    src = ICONS[name]
    return f'<img alt="{label}" src="{src}" width="16" height="16">'


def description_for(repo: Repo) -> str:
    if repo.description is not None:
        return repo.description.removesuffix(".")

    return ""


def row(repo: Repo) -> str:
    description = markdown_escape(description_for(repo))
    return (
        f"| [{repo.name}]({repo.url}) | {description} | {repo.stargazer_count} | "
        f"{repo.open_issues} | {repo.open_pull_requests} |"
    )


def table(group: Group, repos: dict[str, Repo]) -> str:
    lines = [
        f"### {group.title}",
        "",
        (
            f'| {icon("repo", "Repository")} Repository | Description | '
            f'{icon("star", "Stars")} | {icon("issue", "Open issues")} | '
            f'{icon("pr", "Open pull requests")} |'
        ),
        "|------------|-------------|------:|-------:|----:|",
    ]

    for name in group.repos:
        repo = repos.get(name)
        if repo is None:
            msg = f"missing public repository: {ORG}/{name}"
            raise ProfileReadmeError(msg)
        lines.append(row(repo))

    return "\n".join(lines)


def render(repos: dict[str, Repo]) -> str:
    tables = "\n\n".join(table(group, repos) for group in GROUPS)
    return (
        f"{START}\n"
        "<!-- This section is generated by scripts/update_profile_readme.py. -->\n\n"
        f"{tables}\n"
        f"{END}"
    )


def replace_generated_block(readme: str, block: str) -> str:
    start = readme.find(START)
    end = readme.find(END)
    if start == -1 or end == -1 or end < start:
        msg = f"profile README must contain {START} and {END}"
        raise ProfileReadmeError(msg)

    text = f"{readme[:start]}{block}{readme[end + len(END):]}"
    return text


def main() -> None:
    token = github_token()
    repos = public_repos(token=token)
    readme = README.read_text()
    block = render(repos)
    README.write_text(replace_generated_block(readme, block))


if __name__ == "__main__":
    main()
