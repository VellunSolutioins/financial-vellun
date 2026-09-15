"""A imagem Docker instala por `requirements.txt`; o desenvolvimento, por `pyproject.toml`.

As duas listas divergiram: `prometheus-client` entrou só no `pyproject.toml`, a
suíte passava na venv local e o container morria no boot com
`ModuleNotFoundError`. Este teste impede que uma dependência exista em um lado e
não no outro.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent


def _nomes(especificacoes: list[str]) -> set[str]:
    # Nome normalizado (PEP 503), sem versão nem extras: `uvicorn[standard]>=1` -> `uvicorn`.
    return {
        re.sub(r"[-_.]+", "-", re.split(r"[\[<>=!~;\s]", spec, maxsplit=1)[0]).lower()
        for spec in especificacoes
        if spec.strip() and not spec.strip().startswith("#")
    }


def test_requirements_txt_tem_as_mesmas_dependencias_do_pyproject():
    pyproject = tomllib.loads((RAIZ / "pyproject.toml").read_text(encoding="utf-8"))
    declaradas = _nomes(pyproject["project"]["dependencies"])
    instaladas = _nomes((RAIZ / "requirements.txt").read_text(encoding="utf-8").splitlines())

    assert sorted(declaradas - instaladas) == [], "faltam no requirements.txt (imagem Docker)"
    assert sorted(instaladas - declaradas) == [], "faltam no pyproject.toml"
