# 앱 아이콘 생성기 - 다크 배경 + 커피잔 + 상승/하락 라인 컨셉
# python scripts/make_icons.py 로 실행하면 public/ 아래 아이콘 PNG들이 생긴다.
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "public")

def make(size, path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size / 512.0  # 512 기준 스케일

    # 둥근 사각형 배경 (다크 네이비)
    r = int(112 * s)
    d.rounded_rectangle([0, 0, size, size], radius=r, fill=(13, 17, 23, 255))

    # 가운데 살짝 밝은 원형 글로우
    cx, cy = size / 2, size / 2

    # 미니 차트 라인 (상승 느낌, 파란색)
    pts = [
        (int(96 * s), int(330 * s)),
        (int(168 * s), int(300 * s)),
        (int(232 * s), int(330 * s)),
        (int(300 * s), int(250 * s)),
        (int(372 * s), int(290 * s)),
        (int(420 * s), int(220 * s)),
    ]
    d.line(pts, fill=(88, 166, 255, 255), width=max(2, int(14 * s)), joint="curve")

    # 커피잔 컵 (둥근 사각형)
    cup_l, cup_t, cup_r, cup_b = int(150 * s), int(150 * s), int(330 * s), int(280 * s)
    d.rounded_rectangle([cup_l, cup_t, cup_r, cup_b], radius=int(24 * s),
                        fill=(230, 237, 243, 255))
    # 컵 손잡이
    d.arc([int(320 * s), int(170 * s), int(390 * s), int(255 * s)],
          start=-70, end=70, fill=(230, 237, 243, 255), width=max(2, int(16 * s)))
    # 김(스팀) 두 줄
    for dx in (int(205 * s), int(265 * s)):
        d.line([(dx, int(120 * s)), (dx, int(90 * s))],
               fill=(139, 148, 158, 255), width=max(2, int(10 * s)))

    img.save(path)
    print("saved", path)

make(192, os.path.join(OUT, "icon-192.png"))
make(512, os.path.join(OUT, "icon-512.png"))
# 애플 홈화면용 (180px, 배경 불투명)
make(180, os.path.join(OUT, "apple-touch-icon.png"))
print("done")
