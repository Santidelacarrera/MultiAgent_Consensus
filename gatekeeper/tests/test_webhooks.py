"""Tests de integración del gatekeeper: webhooks → orquestador → GitHub/GitLab."""
import json

from .conftest import GH_SECRET, GL_TOKEN, SHA, approved_view, comment_payload, gh_post, pr_payload

MARKER = "<!-- multiagent-consensus -->"


def statuses(world):
    return [c[2] for c in world.calls if c[0] == "POST" and "/statuses/" in c[1]]


# ---------------------------------------------------------------- seguridad del webhook


def test_health(make_client):
    assert make_client().get("/health").json()["status"] == "ok"


def test_github_rejects_bad_signature(make_client, world):
    r = gh_post(make_client(), "pull_request", pr_payload(), sig="sha256=" + "0" * 64)
    assert r.status_code == 401
    assert world.calls == []


def test_github_rejects_missing_signature_and_wrong_secret(make_client):
    c = make_client()
    assert gh_post(c, "pull_request", pr_payload(), sig="").status_code == 401
    assert gh_post(c, "pull_request", pr_payload(), secret="otro").status_code == 401


def test_github_fails_closed_without_secret(make_client):
    assert gh_post(make_client(github_webhook_secret=None), "ping", {}).status_code == 503


def test_github_ping_and_ignored_events(make_client, world):
    c = make_client()
    assert gh_post(c, "ping", {}).json() == {"status": "pong"}
    assert gh_post(c, "pull_request", pr_payload(action="closed")).json()["status"] == "ignored"
    assert gh_post(c, "pull_request", pr_payload(draft=True)).json()["reason"] == "draft"
    assert gh_post(c, "push", {}).json()["status"] == "ignored"
    assert world.calls == []


# ---------------------------------------------------------------- flujo GitHub


def test_github_pr_approved_posts_minutes_and_success_status(make_client, world):
    r = gh_post(make_client(), "pull_request", pr_payload())
    assert r.status_code == 202 and r.json()["pr"] == "github:acme/shop#7"

    st = statuses(world)
    assert [s["state"] for s in st] == ["pending", "success"]
    assert st[1]["context"] == "multiagent-consensus"
    assert st[1]["target_url"] == "https://consensus.example/v1/debates/d1/minutes"
    # El orquestador recibió el diff y los metadatos del PR
    submit = next(c[2] for c in world.calls if c[0] == "POST" and c[1] == "/v1/debates")
    assert submit["pr"]["headSha"] == SHA and submit["pr"]["repo"] == "acme/shop" and "diff --git" in submit["pr"]["diff"]
    # Minuta publicada como comentario con marcador
    assert len(world.comments) == 1 and world.comments[0]["body"].startswith(MARKER) and "Minuta de prueba" in world.comments[0]["body"]
    # Sin auto-merge por defecto
    assert world.of("PUT", "/repos/acme/shop/pulls/7/merge") == []


def test_orchestrator_called_with_api_key(make_client, world):
    c = make_client()
    gh_post(c, "pull_request", pr_payload())
    # el mock no expone cabeceras en calls; verificamos a través del cliente
    assert c.app.state.service.orchestrator._http.headers["x-api-key"] == "orch-key"


def test_github_comment_is_updated_not_duplicated(make_client, world):
    c = make_client()
    gh_post(c, "pull_request", pr_payload(action="opened"))
    gh_post(c, "pull_request", pr_payload(action="synchronize"))
    assert len(world.comments) == 1
    assert world.of("PATCH", "/repos/acme/shop/issues/comments/")


def test_github_auto_merge_uses_head_sha(make_client, world):
    gh_post(make_client(auto_merge=True), "pull_request", pr_payload())
    merge = world.of("PUT", "/repos/acme/shop/pulls/7/merge")
    assert merge and merge[0][2] == {"sha": SHA, "merge_method": "squash"}
    assert "Merge automático realizado" in world.comments[0]["body"]


def test_github_auto_merge_failure_is_reported_but_status_stays_success(make_client, world):
    world.merge_status = 409
    gh_post(make_client(auto_merge=True), "pull_request", pr_payload())
    assert statuses(world)[-1]["state"] == "success"
    assert "no pudo completarse" in world.comments[0]["body"]


def test_github_rejected_blocks_and_never_merges(make_client, world):
    world.orch_view = approved_view(status="rejected", decision="REJECTED", verdict="REJECTED", reason="Veto de seguridad", summary={})
    gh_post(make_client(auto_merge=True, request_changes=True), "pull_request", pr_payload())
    assert statuses(world)[-1]["state"] == "failure"
    assert world.of("PUT", "/repos/acme/shop/pulls/7/merge") == []
    review = world.of("POST", "/repos/acme/shop/pulls/7/reviews")
    assert review and review[0][2]["event"] == "REQUEST_CHANGES" and review[0][2]["commit_id"] == SHA


def test_github_inconsistent_orchestrator_approval_is_blocked(make_client, world):
    world.orch_view = approved_view(summary={"approvals": 3, "quorum": 2, "hardBlockers": ["red_team:aws-key"], "blockingDissent": []})
    gh_post(make_client(auto_merge=True), "pull_request", pr_payload())
    assert statuses(world)[-1]["state"] == "failure"
    assert world.of("PUT", "/repos/acme/shop/pulls/7/merge") == []


def test_github_escalated_leaves_pending_with_instructions(make_client, world):
    world.orch_view = approved_view(status="escalated", decision="ESCALATED", verdict="PENDING_HUMAN", summary={})
    gh_post(make_client(auto_merge=True), "pull_request", pr_payload())
    last = statuses(world)[-1]
    assert last["state"] == "pending" and "/consensus" in last["description"]
    assert world.of("PUT", "/repos/acme/shop/pulls/7/merge") == []


def test_github_orchestrator_down_fails_closed(make_client, world):
    world.orch_down = True
    gh_post(make_client(auto_merge=True), "pull_request", pr_payload())
    assert statuses(world)[-1]["state"] == "error"
    assert "no debe fusionarse" in world.comments[0]["body"]
    assert world.of("PUT", "/repos/acme/shop/pulls/7/merge") == []


def test_github_waits_for_running_debate(make_client, world):
    # submit devuelve running; la consulta posterior ya trae el resultado final
    gh_post(make_client(), "pull_request", pr_payload())
    assert any(c[0] == "GET" and c[1] == "/v1/debates/d1" for c in world.calls)


def test_github_large_diff_falls_back_to_files_endpoint(make_client, world):
    world.big_diff = True
    gh_post(make_client(), "pull_request", pr_payload())
    submit = next(c[2] for c in world.calls if c[0] == "POST" and c[1] == "/v1/debates")
    diff = submit["pr"]["diff"]
    assert "diff --git a/src/a.ts b/src/a.ts" in diff and "+new" in diff and "img.png" not in diff


# ---------------------------------------------------------------- comandos humanos


ESCALATED = approved_view(status="escalated", decision="ESCALATED", verdict="PENDING_HUMAN", summary={})


def test_senior_resolves_escalated_debate(make_client, world):
    world.orch_view = ESCALATED
    world.orch_history = [ESCALATED]
    world.resolved_view = approved_view(status="resolved_approved", summary={"resolution": {"reviewer": "alice"}})
    r = gh_post(make_client(auto_merge=True), "issue_comment", comment_payload("/consensus approve riesgo aceptado, ticket SEC-1"))
    assert r.status_code == 202
    res = world.of("POST", "/v1/debates/d1/resolution")
    assert res and res[0][2] == {"reviewer": "alice", "decision": "approve", "rationale": "riesgo aceptado, ticket SEC-1"}
    assert statuses(world)[-1]["state"] == "success"
    assert world.of("PUT", "/repos/acme/shop/pulls/7/merge")


def test_command_from_unauthorized_user_is_refused(make_client, world):
    world.orch_history = [ESCALATED]
    gh_post(make_client(senior_reviewers=("bob",)), "issue_comment", comment_payload("/consensus approve ok"))
    assert world.of("POST", "/v1/debates/d1/resolution") == []
    assert any("no está autorizado" in c["body"] for c in world.comments)


def test_command_requires_write_permission(make_client, world):
    world.permission = "read"
    world.orch_history = [ESCALATED]
    gh_post(make_client(), "issue_comment", comment_payload("/consensus approve ok"))
    assert world.of("POST", "/v1/debates/d1/resolution") == []


def test_command_requires_rationale(make_client, world):
    world.orch_history = [ESCALATED]
    gh_post(make_client(), "issue_comment", comment_payload("/consensus reject"))
    assert world.of("POST", "/v1/debates/d1/resolution") == []
    assert any("requiere un motivo" in c["body"] for c in world.comments)


def test_command_without_escalated_debate_for_current_commit(make_client, world):
    world.orch_history = [approved_view()]  # no escalado
    gh_post(make_client(), "issue_comment", comment_payload("/consensus approve x"))
    assert world.of("POST", "/v1/debates/d1/resolution") == []
    assert any("No hay un debate escalado" in c["body"] for c in world.comments)


def test_stale_escalation_for_old_commit_is_not_resolved(make_client, world):
    world.orch_history = [{**ESCALATED, "headSha": "b" * 40}]
    gh_post(make_client(), "issue_comment", comment_payload("/consensus approve x"))
    assert world.of("POST", "/v1/debates/d1/resolution") == []


def test_bot_comments_and_non_commands_are_ignored(make_client, world):
    c = make_client()
    assert gh_post(c, "issue_comment", comment_payload("/consensus approve x", user_type="Bot")).json()["status"] == "ignored"
    assert gh_post(c, "issue_comment", comment_payload("LGTM")).json()["status"] == "ignored"
    assert gh_post(c, "issue_comment", comment_payload("/consensus approve x", is_pr=False)).json()["status"] == "ignored"
    assert world.calls == []


# ---------------------------------------------------------------- GitLab


def gl_post(client, event, payload, token=GL_TOKEN):
    return client.post("/webhooks/gitlab", content=json.dumps(payload), headers={"x-gitlab-event": event, "x-gitlab-token": token, "content-type": "application/json"})


def mr_payload(action="open", extra=None):
    attrs = {"iid": 3, "action": action, "title": "MR", "description": "d", "target_branch": "main", "last_commit": {"id": SHA}}
    attrs.update(extra or {})
    return {"project": {"id": 42, "path_with_namespace": "grp/proj"}, "object_attributes": attrs, "user": {"username": "dev"}, "labels": [{"title": "l"}]}


def test_gitlab_token_validation(make_client):
    c = make_client()
    assert gl_post(c, "Merge Request Hook", mr_payload(), token="bad").status_code == 401
    assert gl_post(make_client(gitlab_webhook_token=None), "Merge Request Hook", mr_payload()).status_code == 503


def test_gitlab_merge_request_flow(make_client, world):
    world.orch_view = approved_view(prId="gitlab:grp/proj#3")
    r = gl_post(make_client(auto_merge=True), "Merge Request Hook", mr_payload())
    assert r.status_code == 202
    sts = [c for c in world.calls if c[0] == "POST" and "/statuses/" in c[1]]
    assert [s[2]["state"] for s in sts] == ["running", "success"]  # pending → running en GitLab
    assert sts[1][2]["name"] == "multiagent-consensus"
    submit = next(c[2] for c in world.calls if c[0] == "POST" and c[1] == "/v1/debates")["pr"]
    assert submit["provider"] == "gitlab" and submit["repo"] == "grp/proj" and submit["number"] == 3
    assert "diff --git a/b.py b/b.py" in submit["diff"] and "--- /dev/null" in submit["diff"] and "+z" in submit["diff"]
    assert world.comments and world.comments[0]["body"].startswith(MARKER)
    assert world.of("PUT", "/api/v4/projects/42/merge_requests/3/merge")


def test_gitlab_rejected_sets_failed(make_client, world):
    world.orch_view = approved_view(status="rejected", decision="REJECTED", verdict="REJECTED", summary={})
    gl_post(make_client(), "Merge Request Hook", mr_payload())
    sts = [c[2]["state"] for c in world.calls if c[0] == "POST" and "/statuses/" in c[1]]
    assert sts[-1] == "failed"


def test_gitlab_update_only_with_new_commits_and_skips_drafts(make_client, world):
    c = make_client()
    assert gl_post(c, "Merge Request Hook", mr_payload(action="update")).json()["status"] == "ignored"
    assert gl_post(c, "Merge Request Hook", mr_payload(action="update", extra={"oldrev": "x"})).status_code == 202
    assert gl_post(c, "Merge Request Hook", mr_payload(extra={"draft": True})).json()["reason"] == "draft"
    assert gl_post(c, "Merge Request Hook", mr_payload(action="merge")).json()["status"] == "ignored"


def test_gitlab_note_command_resolves(make_client, world):
    world.orch_history = [{**ESCALATED, "prId": "gitlab:grp/proj#3"}]
    world.resolved_view = approved_view(status="resolved_rejected", summary={"resolution": {"reviewer": "alice"}})
    payload = {
        "project": {"id": 42, "path_with_namespace": "grp/proj"},
        "user": {"username": "alice"},
        "object_attributes": {"noteable_type": "MergeRequest", "note": "/consensus reject SQLi confirmada"},
        "merge_request": {"iid": 3},
    }
    r = gl_post(make_client(), "Note Hook", payload)
    assert r.status_code == 202
    res = world.of("POST", "/v1/debates/d1/resolution")
    assert res and res[0][2]["decision"] == "reject" and res[0][2]["reviewer"] == "alice"
    sts = [c[2]["state"] for c in world.calls if c[0] == "POST" and "/statuses/" in c[1]]
    assert sts[-1] == "failed"


def test_gitlab_ignores_other_events(make_client, world):
    c = make_client()
    assert gl_post(c, "Push Hook", {}).json()["status"] == "ignored"
    assert gl_post(c, "Note Hook", {"object_attributes": {"noteable_type": "Issue", "note": "/consensus approve x"}}).json()["status"] == "ignored"
