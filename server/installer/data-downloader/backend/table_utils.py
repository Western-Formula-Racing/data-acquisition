from __future__ import annotations


def quote_identifier(identifier: str) -> str:
    trimmed = identifier.strip()
    if trimmed.startswith('"') and trimmed.endswith('"'):
        trimmed = trimmed[1:-1]
    return f'"{trimmed}"'


def quote_table(identifier: str) -> str:
    parts = [part for part in identifier.split(".") if part.strip()]
    if not parts:
        raise ValueError("Empty identifier")
    return ".".join(quote_identifier(part) for part in parts)


def quote_literal(value: str) -> str:
    escaped = value.replace("'", "''")
    return f"'{escaped}'"
