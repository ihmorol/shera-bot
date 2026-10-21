Target: reconstruct the supplied orange-and-cream plush robot as actual 3D
geometry. The earlier smooth GLB is rejected and remains preserved as v1.

1. Compare reference against v1; correct silhouette, face depth, arm pose,
   colors, and view framing.
2. Build v2 with short geometric fur on plush surfaces, rounded eye ends,
   smooth joined shading, and separate editable parts.
3. Verify GLB buffers, index ranges, normals, and float animation. Inspect
   front, side, and back in the browser before saving the final preview.

Scope: standalone avatar asset and its preview only; no product changes.
Reference: reference.png, copied without alteration from the attachment.
Run: python output/avatars/build_avatar_v2.py
Preview: http://127.0.0.1:8793/preview.html
Fidelity remains a visual judgment; loading successfully does not prove it.

Revision results:
- Geometry/material revision delivered as shera-main-v2.glb; v1 preserved.
- Binary, indices, finite values, unit normals, textures and animation checks passed.
- Browser load, front/side/back views, animation pause and resume observed.
- Independent fidelity review: improved approximation; close match not achieved.
- Remaining gaps: primitive sculpt, mitten shaping, dense soft fur and cinematic lighting.
- build_avatar_v2.py uses the already-installed numpy and Pillow libraries.
- studio.hdr supplies preview lighting; GLB geometry and texture are self-contained.
