import logging
import os
import sys
from pathlib import Path


def get_log_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home()))
        return base / "rednote-mcp" / "logs"
    elif sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "rednote-mcp" / "logs"
    else:
        return Path.home() / ".local" / "share" / "rednote-mcp" / "logs"


def get_logger(name: str) -> logging.Logger:
    log_dir = get_log_dir()
    log_dir.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger(name)
    if logger.handlers:
        return logger

    logger.setLevel(logging.DEBUG)

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )

    # File handler
    fh = logging.FileHandler(log_dir / "rednote-mcp.log", encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    # Stderr handler (MCP uses stdout for protocol, so log to stderr)
    sh = logging.StreamHandler(sys.stderr)
    sh.setLevel(logging.INFO)
    sh.setFormatter(fmt)
    logger.addHandler(sh)

    return logger
