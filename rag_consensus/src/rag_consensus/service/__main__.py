"""python -m rag_consensus.service  → uvicorn con la fábrica de la aplicación."""
import os

import uvicorn

if __name__ == "__main__":  # pragma: no cover
    uvicorn.run("rag_consensus.service.app:app_factory", factory=True, host=os.environ.get("HOST", "0.0.0.0"),
                port=int(os.environ.get("PORT", "8090")), log_level=os.environ.get("LOG_LEVEL", "info").lower(), access_log=False)
