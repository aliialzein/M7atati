# Report font

`DejaVuSans.ttf` is unmodified DejaVu Sans 2.35, distributed under the included
`LICENSE_DEJAVU`. Source: the Matplotlib project's
[bundled font](https://github.com/matplotlib/matplotlib/blob/main/lib/matplotlib/mpl-data/fonts/ttf/DejaVuSans.ttf)
and [license](https://github.com/matplotlib/matplotlib/blob/main/lib/matplotlib/mpl-data/fonts/ttf/LICENSE_DEJAVU).

`coverage.json` contains inclusive Unicode ranges derived from this exact font's
best cmap with Python fontTools. Regenerate it when replacing the font. PDF
generation validates text against these ranges and the renderer's BMP limit so
unsupported text fails explicitly rather than rendering missing glyphs.

Keep this directory with the API package when deploying source or compiled code.
The runtime loads it relative to `@smart-fuel-station/api/package.json`.
