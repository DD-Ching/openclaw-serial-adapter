from __future__ import annotations

from typing import Any, Dict


class ExamplePlugin:
    """Minimal example plugin that marks state as processed."""

    def __init__(self) -> None:
        pass

    def process(self, state: Dict[str, Any]) -> Dict[str, Any]:
        """Return state with a processed flag set to True."""
        if not isinstance(state, dict):
            raise TypeError("state must be a dict")
        output = dict(state)
        output["processed"] = True
        return output
