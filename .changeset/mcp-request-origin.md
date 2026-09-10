---
"blume": patch
---

Reject cross-origin MCP requests before transport processing while accepting absent or exact same-origin headers, including on preview deployments. Reflect accepted origins in CORS responses and vary all responses by Origin without losing existing cache variation.
