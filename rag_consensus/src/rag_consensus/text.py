"""Utilidades de texto deterministas (sin dependencias externas), pensadas para español e inglés."""
from __future__ import annotations

import re
import unicodedata

_WORD = re.compile(r"[^\W_]+", re.UNICODE)
_NUMBER = re.compile(r"\d[\d.,]*")
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+|\n+")
CITATION = re.compile(r"\[([A-Za-z0-9_.:\-]{1,64})\]")

STOPWORDS = frozenset(
    """
    a al algo ante aquel aqui as asi aun aunque cada como con contra cual cuando de del desde donde dos el ella ellos en entre era
    eran es esa ese eso esta estan este esto fue fueron ha han hasta hay la las le les lo los mas me mi muy no nos o otra otro para
    pero por porque que quien se sea ser si sin sobre son su sus tambien te tiene tienen todo tras tu un una uno unos unas y ya
    the and are was were for with that this these those from have has had not but you your can will would should could into about
    than then them they their there which what when where who whom been being its it's also any all each such only own same too very
    """.split()
)

ABSTENTION = re.compile(
    r"\b(no (tengo|dispongo de|cuento con|se encontr[óo]|encontr[ée]|hay) (suficiente )?informaci[óo]n|no (lo )?s[ée]|"
    r"i (do not|don't) (know|have enough)|no (relevant )?information (was )?(found|available)|cannot (find|answer))",
    re.IGNORECASE,
)

_NEGATIONS = frozenset({"no", "nunca", "jamas", "ni", "not", "never", "cannot", "without", "sin"})


def fold(text: str) -> str:
    """Minúsculas, NFKC y sin diacríticos (para comparar sin sensibilidad a acentos)."""
    decomposed = unicodedata.normalize("NFKD", unicodedata.normalize("NFKC", text).casefold())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def stem(token: str) -> str:
    if len(token) > 5 and token.endswith("es"):
        return token[:-2]
    if len(token) > 4 and token.endswith("s"):
        return token[:-1]
    return token


def content_tokens(text: str) -> frozenset[str]:
    out: set[str] = set()
    for w in _WORD.findall(fold(text)):
        if w.isdigit():
            out.add(w)
        elif len(w) >= 3 and w not in STOPWORDS and w not in _NEGATIONS:
            out.add(stem(w))
    return frozenset(out)


def numbers(text: str) -> frozenset[str]:
    """Números normalizados (sin separadores de miles/decimales: '1.250,5' → '12505')."""
    return frozenset(re.sub(r"\D", "", m) for m in _NUMBER.findall(text) if re.sub(r"\D", "", m))


def split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_SPLIT.split(text) if s and s.strip()]


def entities(sentence: str) -> frozenset[str]:
    """Palabras capitalizadas que no abren la frase (nombres propios / siglas probables)."""
    return frozenset(fold(w) for w in _WORD.findall(sentence)[1:] if len(w) >= 3 and w[0].isupper())


def is_abstention(text: str) -> bool:
    return bool(ABSTENTION.search(text))


def negation_signature(sentence: str) -> tuple[frozenset[str], bool]:
    """(tokens de contenido, ¿contiene negación?) para detectar contradicciones directas entre frases."""
    toks = _WORD.findall(fold(sentence))
    negated = any(t in _NEGATIONS for t in toks)
    return content_tokens(sentence), negated
