"""A imagem instala pelo `requirements.lock`; o desenvolvimento, por `pyproject.toml`.

As duas listas divergiram: `prometheus-client` entrou só no `pyproject.toml`, a
suíte passava na venv local e o container morria no boot com
`ModuleNotFoundError`. Este teste impede que uma dependência exista em um lado e
não no outro.

O `requirements.lock` (gerado de `requirements.txt`, com hashes) é o que a
imagem instala: uma dependência nova sem regerar o lock quebraria o container
do mesmo jeito.
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


def test_lock_cobre_as_dependencias_diretas():
    # O lock é gerado de `requirements.txt`; regerar depois de mexer nele:
    # docker run --rm -v "$PWD:/w" -w /w python:3.12-slim sh -c     #   "pip install -q pip-tools && pip-compile --generate-hashes --output-file requirements.lock requirements.txt"
    diretas = _nomes((RAIZ / "requirements.txt").read_text(encoding="utf-8").splitlines())
    lock = (RAIZ / "requirements.lock").read_text(encoding="utf-8")
    travadas = _nomes([linha for linha in lock.splitlines() if linha and not linha[0].isspace()])

    assert sorted(diretas - travadas) == [], "requirements.lock desatualizado (regere com pip-compile)"


def test_lock_tem_hash_para_toda_versao_travada():
    # Cada pacote ocupa um bloco: `nome==versao \` seguido das linhas de hash.
    linhas = (RAIZ / "requirements.lock").read_text(encoding="utf-8").splitlines()
    sem_hash = [
        linha
        for indice, linha in enumerate(linhas)
        if "==" in linha and "--hash=sha256:" not in "".join(linhas[indice : indice + 2])
    ]

    assert any("==" in linha for linha in linhas), "requirements.lock vazio"
    assert sem_hash == [], "versão sem hash no lock"
