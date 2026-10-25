# 扰人杀手：接通嘴部并统一整套图形

生成方式：内置 image_gen（imagegen 技能），非 CLI。

本版以接通左侧笑嘴后的母图为基准，替代旧版断开的嘴形。黑色主标、白色应用图标与完整展示板使用本版视觉造型。

输出为白底 PNG 设计稿，尚未替换浏览器扩展运行时图标。

交付文件：`logo-master.png`、`app-icon.png`、`brand-board.png`。

视觉验收：主标和应用图标的左嘴角均与主笑嘴连通；完整展示板内主标、应用图标和单色版三处都使用该连通嘴形，无旧版断嘴与斩线分叉。由主代理及独立只读审查逐项确认。图像编辑产物为同一视觉版本，不宣称共享矢量路径或像素级完全一致。

## 主标提示词

```text
Use case: precise-object-edit.
Image 1 is the current black-face red-slash logo master to edit. Image 2 shows the user's red boxes identifying the disconnected LEFT MOUTH. Image 3 is a magnified crop of the inverse-color icon showing the same disconnected mouth; it is a detail reference, not an output layout.

CONNECT THE MOUTH OPENING. This means the WHITE NEGATIVE-SPACE SMILE inside the BLACK FACE, not the exterior face outline.
Currently there is an isolated upturned white smile corner below the left eye (roughly x300–410, y692–790 of the master), and a separate white fanged grin beginning abruptly at roughly x487,y847. A thick solid BLACK BRIDGE incorrectly cuts the smile into two disconnected pieces.
REMOVE THAT BLACK BRIDGE by extending the left end of the MAIN WHITE GRIN upwards and leftwards to meet the upturned white smile corner. The mouth must become ONE continuous broad crescent-shaped opening from the far-left upturned corner to the far-right upturned corner. In particular, the current blunt vertical left end of the lower white grin must disappear: continue the white mouth shape all the way left/up to the underside of the red diagonal slash. If the red slash were lifted off, the white smile would be a single connected curve with no black wall through it. The RED SLASH remains a separate unchanged foreground stroke covering the mouth where they cross.
Do NOT merely smooth or thicken the black cheek; that would retain the incorrect mouth separation. This edit must visibly open up the black barrier on the left side of the white grin. Keep the outer black jaw curve intact with sensible even thickness. Keep the current white fangs and right smile unchanged.

Everything else stays identical: head silhouette and horn, two eyes, position and shape of clean unbranched red slash, face proportions, pure black/white/red colors, white canvas. No new symbols, text or layout. Output exactly ONE corrected black master symbol, same scale and placement. The red annotation boxes must not appear.
```

## 应用图标提示词

```text
Use case: precise-object-edit.
This input is the FINAL corrected logo master. The LEFT SMILE IS NOW CONNECTED; preserve that correction exactly.

Make only its reversed-color app-icon variant. Keep the entire master geometry unchanged: the connected broad crescent grin starting at the upturned left mouth corner, extending under the red slash and continuously into the fanged right smile; same jaw, eyes, horn, cheek points and clean convex red slash. Do not put a white bridge back across the black smile on its left side. The mouth must remain continuous behind the foreground red slash.

Change the black FACE to flat WHITE, and its white eye/mouth negative spaces to BLACK. Keep red unchanged. Place that SAME uniformly scaled logo on a BLACK rounded-square app tile, white outside the tile. Preserve proportions, slash angle and fang shapes. The whole symbol, including both slash tips, fits inside the tile with comfortable padding. One app icon on a square canvas only; no text, glow, shadow, textures or other graphic variations. This is a color-inverted copy of the supplied geometry, NOT a redesign.
```

## 展示板提示词

```text
Use case: compositing / logo-brand.
Create the UPDATED “扰人杀手” identity board, on pure white, landscape.
Image 1: THE FINAL CORRECTED BLACK/RED MASTER SYMBOL. Copy this geometry exactly, including its CONNECTED smile.
Image 2: THE FINAL CORRECTED APP ICON. Copy this icon exactly, including its CONNECTED smile.
Image 3: OLD BOARD, reference ONLY for the four Chinese wordmark characters and their type style / placement. Its face icons are OBSOLETE and MUST NOT be used.

Composition:
- Top: the exact black/red master from Image 1 on the left and the wordmark “扰人杀手” on the right, in the original bold slanted black cut-letter style from Image 3, with original red accents.
- Below: the exact rounded-square app icon from Image 2; beside it a small monochrome version of THE NEW MASTER from Image 1, using identical geometry with the red slash recolored black.
- Clean white background, balanced spacing, no captions or new text.

Consistency requirements override Image 3: Every mascot on this board uses the SAME NEW connected-mouth shape. Do NOT include any of the old disconnected-mouth or forked-red-slash icons from Image 3. The mouth is one broad continuous grin that goes from the left upturned corner under the red slash to the right fanged grin, with no face-colored vertical wall blocking the left side of the mouth. The red slash remains a single uninterrupted clean convex blade, NO lower-left secondary tip, no tiny branch, no serration. Preserve the NEW eye shapes, NEW jaw curve, NEW fangs and NEW head silhouette from Image 1. All three marks are matching instances, not variations or redesigns.

Do not alter the actual design of Images 1 and 2: composite/scale uniformly only. Do not copy the obsolete geometry from Image 3. No checkerboard, glow, textures, shadows or annotation boxes. Output one complete updated presentation board.
```
