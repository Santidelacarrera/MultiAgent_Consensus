"""Caso de uso del gatekeeper: PR → debate → veredicto → acciones sobre la plataforma."""
from __future__ import annotations

import json
import logging
from typing import Any, Callable

from .config import Settings
from .models import PrRef, Verdict
from .orchestrator_client import OrchestratorClient, OrchestratorError
from .policy import decide, parse_command
from .vcs import VcsClient, VcsError

log = logging.getLogger("gatekeeper")

CONFIG_PATH = ".consensus.json"


def load_repo_settings(vcs: VcsClient, ref: PrRef) -> dict[str, Any]:
    """Lee `.consensus.json` de la rama BASE (el autor del PR no puede aflojar sus propias reglas).

    Claves admitidas: monthlyBudgetUsd, maxRounds, ignorePaths. Un fichero inválido se ignora (valores por defecto)
    y se avisa en el log; el orquestador vuelve a validar los rangos.
    """
    try:
        raw = vcs.get_file(ref, CONFIG_PATH)
        if raw is None:
            return {}
        data = json.loads(raw)
    except (VcsError, ValueError) as e:
        log.warning("%s ilegible en %s: %s", CONFIG_PATH, ref.repo, e)
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: data[k] for k in ("monthlyBudgetUsd", "maxRounds", "ignorePaths") if k in data}


class GateService:
    def __init__(self, settings: Settings, orchestrator: OrchestratorClient, vcs_factory: Callable[[str], VcsClient]) -> None:
        self.settings = settings
        self.orchestrator = orchestrator
        self._vcs_factory = vcs_factory
        self._vcs: dict[str, VcsClient] = {}

    def vcs(self, provider: str) -> VcsClient:
        if provider not in self._vcs:
            self._vcs[provider] = self._vcs_factory(provider)
        return self._vcs[provider]

    # ------------------------------------------------------------------ PR event

    def process_pr(self, ref: PrRef) -> Verdict | None:
        """Ejecuta el gate completo para un PR. Nunca lanza: ante error falla cerrado (estado `error`)."""
        try:
            vcs = self.vcs(ref.provider)
        except VcsError as e:
            log.error("sin cliente VCS para %s: %s", ref.provider, e)
            return None
        try:
            if not ref.head_sha:
                ref = vcs.get_pr(ref)
            vcs.set_status(ref, "pending", "Debate multi-agente en curso…")
            if not ref.base_branch:
                ref = vcs.get_pr(ref)
            diff = vcs.get_diff(ref)
            settings = load_repo_settings(vcs, ref)
            view = self.orchestrator.submit(
                {
                    "provider": ref.provider,
                    "repo": ref.repo,
                    "number": ref.number,
                    "title": ref.title,
                    "description": ref.description,
                    "author": ref.author,
                    "baseBranch": ref.base_branch,
                    "headSha": ref.head_sha,
                    "labels": list(ref.labels),
                    "diff": diff,
                },
                settings=settings,
            )
            if view.get("status") == "running":
                view = self.orchestrator.wait(view["id"], self.settings.debate_timeout_s)
            return self.publish(ref, vcs, view)
        except Exception as e:  # noqa: BLE001 — frontera de proceso: fallar cerrado
            log.exception("gate falló para %s", ref.pr_id)
            verdict = Verdict("error", f"Gatekeeper: {type(e).__name__}. Falla cerrado.")
            try:
                vcs.set_status(ref, verdict.state, verdict.description)
                vcs.upsert_comment(
                    ref,
                    "## ⚠️ MultiAgent Consensus no pudo completar la revisión\n\n"
                    f"No se pudo emitir un veredicto (`{type(e).__name__}`). El check queda en error y "
                    "**el cambio no debe fusionarse** hasta que se reintente.",
                )
            except Exception:  # noqa: BLE001
                log.exception("no se pudo reportar el error de %s", ref.pr_id)
            return verdict

    def publish(self, ref: PrRef, vcs: VcsClient, view: dict[str, Any]) -> Verdict:
        """Convierte el resultado del debate en acciones: minuta, estado, bloqueo y/o merge."""
        verdict = decide(view)
        debate_id = view.get("id")
        target = None
        if self.settings.orchestrator_public_url and debate_id:
            target = f"{self.settings.orchestrator_public_url.rstrip('/')}/v1/debates/{debate_id}/minutes"

        comment: str | None = None
        if view.get("status") == "error":
            comment = (
                f"## ⚠️ MultiAgent Consensus: error\n\n{view.get('reason') or 'Error desconocido'}\n\n"
                "El check queda en error (falla cerrado)."
            )
        elif debate_id:
            try:
                comment = self.orchestrator.minutes(debate_id)
            except OrchestratorError:
                log.warning("minuta no disponible para %s", debate_id)

        merge_note = ""
        if verdict.mergeable and self.settings.auto_merge:
            try:
                vcs.merge(ref)
                merge_note = "\n\n✅ **Merge automático realizado.**"
            except VcsError as e:
                log.warning("auto-merge falló: %s", e)
                merge_note = f"\n\n⚠️ El merge automático no pudo completarse: {str(e)[:200]}"
        if verdict.blocking and self.settings.request_changes:
            try:
                vcs.request_changes(ref, f"MultiAgent Consensus bloquea este cambio: {verdict.description}")
            except VcsError as e:
                log.warning("request changes falló: %s", e)

        vcs.set_status(ref, verdict.state, verdict.description, target)
        if comment:
            vcs.upsert_comment(ref, comment + merge_note)
        return verdict

    # ------------------------------------------------------------------ comandos humanos

    def handle_command(self, ref: PrRef, user: str, body: str) -> Verdict | None:
        """`/consensus approve|reject <motivo>` de un ingeniero senior sobre un debate escalado."""
        cmd = parse_command(body)
        if cmd is None:
            return None
        decision, rationale = cmd
        try:
            vcs = self.vcs(ref.provider)
        except VcsError as e:
            log.error("sin cliente VCS para %s: %s", ref.provider, e)
            return None
        try:
            if not rationale:
                vcs.post_comment(ref, f"@{user}: el comando requiere un motivo. Uso: `/consensus approve|reject <motivo>`.")
                return None
            senior = self.settings.senior_reviewers
            if (senior and user.lower() not in senior) or not vcs.has_write_access(ref, user):
                vcs.post_comment(ref, f"@{user} no está autorizado para resolver escalados de este repositorio.")
                return None
            ref = vcs.get_pr(ref)
            target = next(
                (d for d in self.orchestrator.history(ref.pr_id) if d.get("status") == "escalated" and d.get("headSha") == ref.head_sha),
                None,
            )
            if target is None:
                vcs.post_comment(ref, "No hay un debate escalado pendiente para el commit actual de este PR.")
                return None
            view = self.orchestrator.resolve(target["id"], user, decision, rationale)
            return self.publish(ref, vcs, view)
        except Exception:  # noqa: BLE001
            log.exception("comando falló para %s", ref.pr_id)
            return None
