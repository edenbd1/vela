# Vela mark

Four chevrons, apex at the centre, opening outward. One arm rotated four
times — the whole mark is a single path, which is why it survives being
scaled down to a 40px device icon without turning to mush.

```
vela-mark.svg          the mark, fill="currentColor" — use this one
vela-mark-white.svg    for dark backgrounds
vela-mark-black.svg    for light backgrounds
vela-mark-{512,256,64}.png

app_vela_64px.gif      device glyph, used on every review screen
app_vela_40px.gif      Flex app icon
app_vela_32px.gif      Stax
app_vela_14px.gif      Nano
```

The `.gif` files are palette-mode, two colours. Ledger's loader asserts
`mode == "P"` and a small colour count, and rejects anything else at install
time — regenerate them with the script below rather than exporting by hand.

```bash
rsvg-convert -w 40 -h 40 -b '#ffffff' vela-mark-black.svg -o /tmp/i.png
python3 -c "
from PIL import Image
Image.open('/tmp/i.png').convert('L').point(lambda p: 0 if p<128 else 255,'1') \
     .convert('P').save('app_vela_40px.gif')"
```
