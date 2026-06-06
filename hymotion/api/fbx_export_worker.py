from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--status", required=True)
    args = parser.parse_args()

    exit_code = 1
    try:
        request = json.loads(Path(args.request).read_text(encoding="utf-8"))
        ok = _run_export(request=request, output_path=Path(args.output))
        _write_status(Path(args.status), {"ok": ok})
        exit_code = 0 if ok else 1
    except Exception as exc:
        _write_status(Path(args.status), {"ok": False, "error": str(exc)})
        exit_code = 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        # The Autodesk FBX SDK Python binding can segfault during interpreter
        # shutdown. Exit without running module/global destructors so the crash
        # is contained in this worker process.
        os._exit(exit_code)


def _run_export(*, request: Dict[str, Any], output_path: Path) -> bool:
    from hymotion.utils.smplh2woodfbx import SMPLH2WoodFBX

    npz_path = Path(request["npzPath"])
    template_path = Path(request["templateFbxPath"])
    include_skin = bool(request.get("includeSkin", True))
    fps = int(request.get("fps", 30))

    converter = SMPLH2WoodFBX(template_fbx_path=str(template_path), scale=100)
    ok = converter.convert_npz_to_fbx(str(npz_path), str(output_path), fps=fps)
    if ok and not include_skin:
        _strip_fbx_mesh_nodes(output_path)
    return ok and output_path.exists()


def _strip_fbx_mesh_nodes(path: Path) -> None:
    import fbx
    from hymotion.utils.smplh2woodfbx import _loadFbxScene, _saveScene

    manager = fbx.FbxManager.Create()
    ios = fbx.FbxIOSettings.Create(manager, fbx.IOSROOT)
    manager.SetIOSettings(ios)
    try:
        scene = _loadFbxScene(manager, str(path))
        root = scene.GetRootNode()
        _remove_mesh_children(root)
        _saveScene(str(path), manager, scene, embed_textures=False)
    finally:
        manager.Destroy()


def _remove_mesh_children(node: Any) -> None:
    import fbx

    for index in range(node.GetChildCount() - 1, -1, -1):
        child = node.GetChild(index)
        _remove_mesh_children(child)
        attr = child.GetNodeAttribute()
        if attr and attr.GetAttributeType() == fbx.FbxNodeAttribute.EType.eMesh:
            while child.GetChildCount() > 0:
                grandchild = child.GetChild(0)
                child.RemoveChild(grandchild)
                node.AddChild(grandchild)
            node.RemoveChild(child)
            child.Destroy()


def _write_status(path: Path, payload: Dict[str, Any]) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


if __name__ == "__main__":
    main()
