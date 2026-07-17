"""Tests del esquema: init_db idempotente, tablas, WAL."""
from __future__ import annotations

import sqlite3

from porcipeso.db.repo import Repo, init_db

EXPECTED_TABLES = {"sesiones", "eventos_pesaje", "lecturas_crudas"}


def _tables(path) -> set[str]:
    conn = sqlite3.connect(path)
    try:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
        return {r[0] for r in rows}
    finally:
        conn.close()


def test_init_db_crea_tablas(tmp_path):
    db = tmp_path / "p.db"
    init_db(db)
    assert EXPECTED_TABLES <= _tables(db)


def test_init_db_es_idempotente(tmp_path):
    db = tmp_path / "p.db"
    init_db(db)
    repo = Repo(db)
    sid = repo.create_session({"lote": "L-1"})
    repo.close()
    init_db(db)  # segunda corrida: no debe fallar ni borrar datos
    repo2 = Repo(db)
    assert repo2.get_session(sid) is not None
    repo2.close()


def test_init_db_crea_directorios(tmp_path):
    db = tmp_path / "anidado" / "mas" / "p.db"
    init_db(db)
    assert db.exists()


def test_init_db_migra_columna_modo_en_db_vieja(tmp_path):
    """DB pre-v2 (sesiones sin columna 'modo'): init_db la agrega con
    ALTER TABLE y las filas existentes quedan en 'lote'."""
    db = tmp_path / "vieja.db"
    conn = sqlite3.connect(db)
    try:
        # esquema viejo mínimo (sin 'modo'); el CREATE IF NOT EXISTS del
        # schema.sql NO lo recrea, así que fuerza la rama del ALTER
        conn.execute(
            """CREATE TABLE sesiones (
                   id INTEGER PRIMARY KEY, uuid TEXT UNIQUE, lote TEXT,
                   hora_entrada TEXT,
                   estado TEXT NOT NULL DEFAULT 'abierta'
                       CHECK (estado IN ('abierta', 'cerrada', 'anulada'))
               )"""
        )
        conn.execute(
            "INSERT INTO sesiones (uuid, lote, estado) VALUES ('u1', 'L-1', 'abierta')"
        )
        conn.commit()
    finally:
        conn.close()

    init_db(db)

    conn = sqlite3.connect(db)
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(sesiones)")}
        assert "modo" in cols
        (modo,) = conn.execute(
            "SELECT modo FROM sesiones WHERE uuid = 'u1'"
        ).fetchone()
    finally:
        conn.close()
    assert modo == "lote"

    init_db(db)  # idempotente: el ALTER no se repite ni falla


def test_journal_mode_wal(tmp_path):
    db = tmp_path / "p.db"
    Repo(db).close()
    conn = sqlite3.connect(db)
    try:
        (mode,) = conn.execute("PRAGMA journal_mode").fetchone()
    finally:
        conn.close()
    assert mode.lower() == "wal"


def test_estado_check_constraint(tmp_path):
    db = tmp_path / "p.db"
    init_db(db)
    conn = sqlite3.connect(db)
    try:
        try:
            conn.execute(
                "INSERT INTO sesiones (lote, estado) VALUES ('L', 'invalido')"
            )
            raised = False
        except sqlite3.IntegrityError:
            raised = True
    finally:
        conn.close()
    assert raised
