import pytest

from app.config import Settings
from app.policy import decide, parse_command

from .conftest import approved_view


def test_running_and_error():
    assert decide({"status": "running"}).state == "pending"
    v = decide({"status": "error", "reason": "boom"})
    assert v.state == "error" and "boom" in v.description and not v.mergeable


def test_approved_is_mergeable_and_mentions_conditions():
    v = decide(approved_view())
    assert (v.state, v.mergeable, v.blocking) == ("success", True, False)
    v2 = decide(approved_view(summary={"conditions": ["a", "b"], "approvals": 2, "quorum": 2, "hardBlockers": [], "blockingDissent": []}))
    assert v2.state == "success" and "2 condición" in v2.description


@pytest.mark.parametrize(
    "summary,fragment",
    [
        ({"approvals": 3, "quorum": 2, "hardBlockers": ["x"], "blockingDissent": []}, "críticos"),
        ({"approvals": 3, "quorum": 2, "hardBlockers": [], "blockingDissent": ["red_team"]}, "disenso"),
        ({"approvals": 1, "quorum": 2, "hardBlockers": [], "blockingDissent": []}, "quórum no alcanzado"),
        ({"hardBlockers": [], "blockingDissent": []}, "faltan datos"),
    ],
)
def test_inconsistent_approval_fails_closed(summary, fragment):
    v = decide(approved_view(summary=summary))
    assert v.state == "failure" and v.blocking and not v.mergeable
    assert fragment in v.description


def test_rejected_escalated_and_resolutions():
    assert decide({"status": "rejected", "reason": "veto"}).state == "failure"
    esc = decide({"status": "escalated"})
    assert esc.state == "pending" and "/consensus" in esc.description and not esc.mergeable
    ok = decide({"status": "resolved_approved", "summary": {"resolution": {"reviewer": "alice"}}})
    assert ok.state == "success" and ok.mergeable and "alice" in ok.description
    no = decide({"status": "resolved_rejected", "summary": {"resolution": {"reviewer": "bob"}}})
    assert no.state == "failure" and no.blocking


def test_unknown_status_fails_closed():
    v = decide({"status": "???"})
    assert v.state == "error" and not v.mergeable


def test_description_fits_commit_status_limit():
    assert len(decide({"status": "rejected", "reason": "x" * 1000}).description) <= 140


@pytest.mark.parametrize(
    "body,expected",
    [
        ("/consensus approve todo bien", ("approve", "todo bien")),
        ("hola\n/consensus REJECT hay SQLi real\notra línea", ("reject", "hay SQLi real")),
        ("/consensus approve", ("approve", "")),
        ("/consensus maybe x", None),
        ("/consensus", None),
        ("sin comando", None),
        ("", None),
    ],
)
def test_parse_command(body, expected):
    assert parse_command(body) == expected


def test_settings_from_env():
    s = Settings.from_env(
        {
            "ORCHESTRATOR_URL": "http://o:3000/",
            "GATEKEEPER_AUTO_MERGE": "true",
            "GATEKEEPER_SENIOR_REVIEWERS": "Alice, bob",
            "DEBATE_TIMEOUT_S": "30",
            "GATEKEEPER_REQUEST_CHANGES": "1",
        }
    )
    assert s.orchestrator_url == "http://o:3000"
    assert s.auto_merge and s.request_changes
    assert s.senior_reviewers == ("alice", "bob")
    assert s.debate_timeout_s == 30
    assert Settings.from_env({}).auto_merge is False
