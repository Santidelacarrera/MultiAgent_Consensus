from __future__ import annotations

import math

import pytest

from rag_consensus import (
    COHERENCE,
    HALLUCINATION,
    TENANT_SECURITY,
    AgentFailure,
    Assessment,
    ConfigurationError,
    ConsensusPolicy,
    Verdict,
    decide,
)

POLICY = ConsensusPolicy()
GOOD = [Assessment(HALLUCINATION, 0.95), Assessment(TENANT_SECURITY, 1.0), Assessment(COHERENCE, 0.9)]


def test_unanimous_good_scores_are_approved() -> None:
    d = decide(GOOD, [], POLICY)
    assert d.verdict is Verdict.APPROVED and not d.reasons and d.aggregate_score == pytest.approx(0.95 * 0.4 + 0.35 + 0.9 * 0.25, abs=1e-3)


def test_veto_rejects_even_with_perfect_scores() -> None:
    d = decide([GOOD[0], Assessment(TENANT_SECURITY, 1.0, veto=True), GOOD[2]], [], POLICY)
    assert d.verdict is Verdict.REJECTED and f"VETO:{TENANT_SECURITY}" in d.reasons


def test_single_agent_below_minimum_rejects_even_if_aggregate_is_high() -> None:
    d = decide([Assessment(HALLUCINATION, 0.5), Assessment(TENANT_SECURITY, 1.0), Assessment(COHERENCE, 1.0)], [], POLICY)
    assert d.verdict is Verdict.REJECTED and any(r.startswith(f"BELOW_MIN:{HALLUCINATION}") for r in d.reasons)


def test_aggregate_threshold_is_enforced() -> None:
    # Todos justo por encima de su mínimo, pero el agregado queda por debajo de 0.80.
    d = decide([Assessment(HALLUCINATION, 0.76), Assessment(TENANT_SECURITY, 0.91), Assessment(COHERENCE, 0.61)], [], POLICY)
    assert d.verdict is Verdict.REJECTED and any(r.startswith("BELOW_AGGREGATE") for r in d.reasons)


def test_missing_agent_fails_closed() -> None:
    d = decide(GOOD[:2], [], POLICY)
    assert d.verdict is Verdict.REJECTED and f"AGENT_MISSING:{COHERENCE}" in d.reasons


def test_failed_agent_fails_closed() -> None:
    d = decide(GOOD[:2], [AgentFailure(COHERENCE, "Timeout")], POLICY)
    assert d.verdict is Verdict.REJECTED and f"AGENT_FAILED:{COHERENCE}:Timeout" in d.reasons
    assert f"AGENT_MISSING:{COHERENCE}" not in d.reasons


@pytest.mark.parametrize("bad", [math.nan, math.inf, -0.1, 1.01])
def test_invalid_scores_fail_closed(bad: float) -> None:
    d = decide([Assessment(HALLUCINATION, bad), GOOD[1], GOOD[2]], [], POLICY)
    assert d.verdict is Verdict.REJECTED and f"INVALID_SCORE:{HALLUCINATION}" in d.reasons


def test_duplicate_votes_are_rejected() -> None:
    d = decide([*GOOD, Assessment(HALLUCINATION, 1.0)], [], POLICY)
    assert d.verdict is Verdict.REJECTED and f"DUPLICATE_ASSESSMENT:{HALLUCINATION}" in d.reasons


def test_empty_committee_is_rejected() -> None:
    assert decide([], [], POLICY).verdict is Verdict.REJECTED


def test_unknown_extra_agents_cannot_tip_the_balance() -> None:
    d = decide([*GOOD, Assessment("intruso", 1.0)], [], POLICY)
    assert d.verdict is Verdict.APPROVED  # se ignora: no es un agente requerido


def test_policy_validation() -> None:
    with pytest.raises(ConfigurationError):
        ConsensusPolicy(min_scores={HALLUCINATION: 0.5}, weights={HALLUCINATION: 1.0})
    with pytest.raises(ConfigurationError):
        ConsensusPolicy(aggregate_threshold=1.5)
    with pytest.raises(ConfigurationError):
        ConsensusPolicy(agent_timeout_s=0)
