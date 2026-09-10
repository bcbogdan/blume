---
"blume": patch
---

Remove redundant Vercel server fallbacks only when an unchanged direct redirect already covers the identical literal pattern and preceding routes cannot rewrite the path. Preserve trailing-slash differences, captures, ambiguous routes, and filesystem precedence instead of broadening redirect matches.
