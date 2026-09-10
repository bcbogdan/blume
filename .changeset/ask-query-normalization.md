---
"blume": patch
---

Improve Ask AI retrieval for conversational questions by removing common query noise while preserving meaningful single-character and Unicode terms, compound identifiers, apostrophes, and compound-word adjacency. Fall back to the original query when no meaningful terms remain. Match standalone single-character terms at Unicode-aware boundaries in spaced scripts so incidental letters in prose do not distract from relevant excerpts.
