"""rag_consensus — conector hacia ContextRAG_Engine y comité de consenso fail-closed."""
from .agents import AssessmentContext, CoherenceValidator, CommitteeAgent, HallucinationCritic, TenantSecurityAuditor
from .client import RagClient, RetrievalPort
from .config import AGENT_NAMES, COHERENCE, HALLUCINATION, TENANT_SECURITY, ConsensusPolicy, RagClientConfig
from .consensus import decide
from .errors import (
    ConfigurationError,
    RagConnectionError,
    RagConsensusError,
    RagError,
    RagHttpError,
    RagProtocolError,
    RagTimeoutError,
)
from .models import (
    AgentFailure,
    Assessment,
    Chunk,
    ConsensusDecision,
    Finding,
    GuardedAnswer,
    RetrievalRequest,
    RetrievalResponse,
    Severity,
    Verdict,
)
from .orchestrator import ConsensusOrchestrator, default_committee

__all__ = [
    "AGENT_NAMES",
    "COHERENCE",
    "HALLUCINATION",
    "TENANT_SECURITY",
    "AgentFailure",
    "Assessment",
    "AssessmentContext",
    "Chunk",
    "CoherenceValidator",
    "CommitteeAgent",
    "ConfigurationError",
    "ConsensusDecision",
    "ConsensusOrchestrator",
    "ConsensusPolicy",
    "Finding",
    "GuardedAnswer",
    "HallucinationCritic",
    "RagClient",
    "RagClientConfig",
    "RagConnectionError",
    "RagConsensusError",
    "RagError",
    "RagHttpError",
    "RagProtocolError",
    "RagTimeoutError",
    "RetrievalPort",
    "RetrievalRequest",
    "RetrievalResponse",
    "Severity",
    "TenantSecurityAuditor",
    "Verdict",
    "decide",
    "default_committee",
]
