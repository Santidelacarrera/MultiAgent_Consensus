import json

from .conftest import gh_post, pr_payload


def submit_body(world):
    return next(c[2] for c in world.calls if c[0] == "POST" and c[1] == "/v1/debates")


def test_repo_config_is_read_from_base_branch_and_forwarded(make_client, world):
    world.repo_config = json.dumps({"monthlyBudgetUsd": 250, "maxRounds": 2, "ignorePaths": ["vendor/**"], "vetoOnCritical": False})
    gh_post(make_client(), "pull_request", pr_payload())
    call = next(c for c in world.calls if c[1] == "/repos/acme/shop/contents/.consensus.json")
    assert call[2] == {"ref": "main"}  # rama base, no la del PR
    body = submit_body(world)
    # sólo claves permitidas: el repo no puede desactivar el veto
    assert body["settings"] == {"monthlyBudgetUsd": 250, "maxRounds": 2, "ignorePaths": ["vendor/**"]}


def test_missing_or_invalid_config_uses_defaults(make_client, world):
    gh_post(make_client(), "pull_request", pr_payload())
    assert "settings" not in submit_body(world)
    world.calls.clear()
    world.repo_config = "{no es json"
    gh_post(make_client(), "pull_request", pr_payload(action="synchronize"))
    assert "settings" not in submit_body(world)


def test_gitlab_reads_config_from_target_branch(make_client, world):
    import httpx

    from app.config import Settings
    from app.models import PrRef
    from app.vcs.gitlab import GitLabClient

    from .conftest import make_settings

    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["path"], seen["params"] = req.url.raw_path.decode(), dict(req.url.params)
        return httpx.Response(200, text='{"maxRounds": 2}') if "raw" in seen["path"] else httpx.Response(404)

    client = GitLabClient(make_settings(), transport=httpx.MockTransport(handler))
    ref = PrRef("gitlab", "grp/proj", 3, base_branch="develop", project_id=42)
    assert client.get_file(ref, ".consensus.json") == '{"maxRounds": 2}'
    assert seen["path"].startswith("/api/v4/projects/42/repository/files/.consensus.json/raw") or "%2E" in seen["path"] or ".consensus.json" in seen["path"]
    assert seen["params"] == {"ref": "develop"}
    assert GitLabClient(make_settings(), transport=httpx.MockTransport(lambda r: httpx.Response(404))).get_file(ref, "x") is None
