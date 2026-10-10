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
