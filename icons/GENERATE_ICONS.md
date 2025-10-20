# Icon Generation Instructions

## Quick Generate (if you have ImageMagick)

```bash
cd icons/

# Generate 192x192
convert icon.svg -resize 192x192 icon-192.png

# Generate 512x512
convert icon.svg -resize 512x512 icon-512.png

# Generate maskable (with padding for safe zone)
convert icon.svg -resize 512x512 -background "#3b82f6" -gravity center -extent 512x512 icon-maskable-512.png

# Generate favicon
convert icon.svg -resize 32x32 favicon.ico
```

## Online Tools (No install needed)

1. Go to https://realfavicongenerator.net/
2. Upload `icon.svg`
3. Generate all sizes
4. Download and replace files in this directory

## Design Tool (Professional)

Use Figma/Sketch/Illustrator to create:
- 192x192 PNG (standard)
- 512x512 PNG (high-res)
- 512x512 PNG maskable (with 10% padding for safe zone)
- 32x32 ICO (favicon)

## Current Status

✅ SVG template created
⏳ PNG files need generation (use commands above)

The app will work without perfect icons, but generates warnings in devtools.


