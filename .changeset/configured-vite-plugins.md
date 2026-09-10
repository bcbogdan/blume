---
"blume": patch
---

Forward vite.plugins through the config bridge in generated and ejected apps, preserving executable plugin hooks and user order.

Keep emitted configuration declarations portable by retaining Astro's public plugin-option types instead of referencing its private Vite installation.
