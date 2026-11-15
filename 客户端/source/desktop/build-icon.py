from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def main() -> None:
    parser = argparse.ArgumentParser(description="Build XiaoLuo Windows icon assets")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    with Image.open(args.source) as source:
        image = source.convert("RGBA")
        side = min(image.size)
        left = (image.width - side) // 2
        top = (image.height - side) // 2
        square = image.crop((left, top, left + side, top + side))
        icon = square.resize((1024, 1024), Image.Resampling.LANCZOS)
        icon.save(args.output / "xiaoluo.png", optimize=True)
        icon.save(
            args.output / "xiaoluo.ico",
            format="ICO",
            sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
        )


if __name__ == "__main__":
    main()
