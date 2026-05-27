import base64

with open('D:/AI/RedCode/packages/desktop/icons/icon.png', 'rb') as f:
    b64 = base64.b64encode(f.read()).decode()

sizes = [(256, "256px"), (128, "128px"), (64, "64px"), (32, "32px"), (16, "16px")]
items = ""
for w, label in sizes:
    items += f'  <div class="item"><img src="data:image/png;base64,{b64}" width="{w}" height="{w}"><div class="label">{label}</div></div>\n'

html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Icon Preview</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ background: #1a1a1a; color: #ccc; font-family: system-ui; padding: 40px; }}
  .row {{ display: flex; gap: 32px; align-items: flex-end; margin-bottom: 32px; }}
  .item {{ text-align: center; }}
  .label {{ font-size: 11px; color: #666; margin-top: 8px; }}
  img {{ border-radius: 8px; }}
</style>
</head>
<body>
<h1 style="font-size:14px;color:#666;margin-bottom:32px;letter-spacing:2px">ICON PREVIEW</h1>
<div class="row">
{items}</div>
</body>
</html>"""

with open('D:/AI/RedCode/packages/desktop/icon-preview.html', 'w') as f:
    f.write(html)
print('saved')
