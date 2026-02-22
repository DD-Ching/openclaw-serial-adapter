from __future__ import annotations

from typing import Any, Dict

try:
    from plugins.registry.manager import load_plugin
except ImportError:
    from registry.manager import load_plugin


def _instantiate() -> Any:
    entry = load_plugin("example_plugin")
    if not entry or not isinstance(entry, dict):
        raise RuntimeError("example_plugin not found in registry")

    entry_str = entry.get("entry")
    if not isinstance(entry_str, str) or ":" not in entry_str:
        raise RuntimeError("Invalid registry entry format")

    module_path, class_name = entry_str.split(":", 1)
    module = __import__(module_path, fromlist=[class_name])
    cls = getattr(module, class_name)
    return cls()


def run_self_test() -> Dict[str, Any]:
    plugin = _instantiate()
    result = plugin.process({"value": 1})
    print(result)
    return result


def main() -> None:
    result = run_self_test()
    if not result.get("processed"):
        raise RuntimeError("processed flag missing")
    print("processed=True")


if __name__ == "__main__":
    main()
